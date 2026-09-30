// scripts/src/lib/contract/runner.ts
//
// The contract pipeline: a resumable, bounded, deterministic state machine.
//
// Deliberately small. The source project had ~40 modules, a manifest store, a
// worktree orchestrator, an escalation ladder and a usage ledger. What that
// bought was a system whose behaviour was hard to predict and harder to test.
// What is kept here is the part that actually mattered:
//
//   * explicit run identity, so a run can be resumed and attributed
//   * a fixed stage order, so the lifecycle is inspectable
//   * bounded retries and timeouts, so a stuck stage cannot hang a run
//   * an injectable adapter, so CI can exercise the whole lifecycle with no
//     model provider and no credentials
//
// What is deliberately absent: any ability to merge or deploy. Creating a
// contract does not authorise publishing its result, and the runner has no code
// path that could.

export const STAGES = ['prepare', 'write', 'implement', 'verify', 'accepted'] as const;

export type Stage = (typeof STAGES)[number];

/** Terminal states. A run ends in exactly one of these. */
export type RunState = 'pending' | 'in_progress' | 'blocked' | 'accepted' | 'cancelled';

export type RunMode = 'standard' | 'full';
/**
 * `standard` — implement, verify. The practical default.
 * `full`      — write, critique, implement, verify, review. Explicit opt-in, for
 *               architecture, auth/permissions, migrations and cross-platform
 *               work. Never the default, because a critique round on every edit
 *               is cost without benefit.
 */
export const MODES: Record<RunMode, readonly Stage[]> = {
  standard: ['prepare', 'implement', 'verify', 'accepted'],
  full: ['prepare', 'write', 'implement', 'verify', 'accepted'],
};

export interface RunManifest {
  runId: string;
  contractId: string;
  mode: RunMode;
  /** The stages this run will pass through, in order. */
  plannedStages: readonly Stage[];
  currentStage: Stage | null;
  state: RunState;
  attempts: Record<string, number>;
  /** Wall-clock deadline for the whole run. */
  deadline: number;
  startedAt: number;
  finishedAt?: number;
  /** Free-form notes. Never used to make a decision. */
  notes: string[];
}

/** Bounds. Every one of these is a number, not a policy string. */
export const LIMITS = {
  maxAttemptsPerStage: 2,
  maxRunMs: 30 * 60_000,
  maxStageMs: 10 * 60_000,
} as const;

/** A run identity. Deterministic given the same inputs, which makes it testable. */
export const makeRunId = (contractId: string, now: number): string =>
  `run-${now.toString(36)}-${contractId.replace(/[^a-z0-9-]/gi, '').toLowerCase()}`;

export type StageOutcome =
  | { ok: true; summary: string }
  | { ok: false; summary: string; retryable: boolean };

/**
 * What actually performs a stage.
 *
 * In production this is where a Pi subprocess is driven. In CI it is a fake.
 * The runner cannot tell the difference, which is the point: the lifecycle under
 * test is the lifecycle that runs.
 */
export interface StageAdapter {
  runStage(stage: Stage, manifest: RunManifest): Promise<StageOutcome>;
}

export type RunResult =
  | { ok: true; manifest: RunManifest; summaries: Record<string, string> }
  | { ok: false; manifest: RunManifest; reason: string };

export const createManifest = (
  contractId: string,
  mode: RunMode,
  now: number,
  runIdOverride?: string,
): RunManifest => ({
  runId: runIdOverride ?? makeRunId(contractId, now),
  contractId,
  mode,
  plannedStages: MODES[mode],
  currentStage: null,
  state: 'pending',
  attempts: {},
  deadline: now + LIMITS.maxRunMs,
  startedAt: now,
  notes: [],
});

/**
 * Resume a run from a persisted manifest.
 *
 * Resuming is a first-class path, not an error path: a run interrupted by a
 * laptop lid should continue where it stopped, and a resumed run must not
 * restart stages that already succeeded.
 *
 * A run that already reached a terminal state is returned unchanged. Resetting
 * `state` unconditionally would turn a cancelled run back into a live one the
 * moment anything called this — the kind of "why did this run twice" that is
 * very hard to diagnose after the fact.
 */
export const resumeManifest = (manifest: RunManifest): RunManifest => {
  if (manifest.state === 'cancelled' || manifest.state === 'accepted') {
    return manifest;
  }

  const remaining = manifest.plannedStages.filter(
    (stage) => manifest.attempts[stage] === undefined,
  );
  return {
    ...manifest,
    state: 'in_progress',
    currentStage: remaining[0] ?? null,
    finishedAt: undefined,
  };
};

const recordAttempt = (manifest: RunManifest, stage: Stage): RunManifest => ({
  ...manifest,
  currentStage: stage,
  state: 'in_progress',
  attempts: { ...manifest.attempts, [stage]: (manifest.attempts[stage] ?? 0) + 1 },
});

/**
 * Run a manifest to completion.
 *
 * Stops at the first stage that fails, retries it up to `maxAttemptsPerStage`,
 * and marks the run `blocked` when the budget is spent. A blocked run is a
 * *reported* outcome, never a pass.
 */
export const runContract = async (
  manifest: RunManifest,
  adapter: StageAdapter,
  clock: () => number = Date.now,
): Promise<RunResult> => {
  const summaries: Record<string, string> = {};
  let current = manifest;

  const done = current.plannedStages.filter((stage) => current.attempts[stage] !== undefined);

  for (const stage of current.plannedStages) {
    if (done.includes(stage)) {
      continue;
    }

    let attempt = 0;
    let succeeded = false;

    while (attempt < LIMITS.maxAttemptsPerStage) {
      if (clock() > current.deadline) {
        return {
          ok: false,
          manifest: { ...current, state: 'blocked', currentStage: null, finishedAt: clock() },
          reason: `Run exceeded its ${LIMITS.maxRunMs / 60_000}-minute budget at stage "${stage}".`,
        };
      }

      current = recordAttempt(current, stage);
      attempt += 1;

      let outcome: StageOutcome;
      try {
        outcome = await adapter.runStage(stage, current);
      } catch (error) {
        // An adapter that throws is a failed attempt, not a crashed run: the
        // retry budget exists precisely for this.
        outcome = {
          ok: false,
          summary: error instanceof Error ? error.message : String(error),
          retryable: true,
        };
      }

      if (outcome.ok) {
        summaries[stage] = outcome.summary;
        succeeded = true;
        break;
      }

      if (!outcome.retryable) {
        return {
          ok: false,
          manifest: {
            ...current,
            state: 'blocked',
            currentStage: null,
            finishedAt: clock(),
            notes: [...current.notes, `${stage}: ${outcome.summary}`],
          },
          reason: `Stage "${stage}" failed and is not retryable: ${outcome.summary}`,
        };
      }
    }

    if (!succeeded) {
      return {
        ok: false,
        manifest: {
          ...current,
          state: 'blocked',
          currentStage: null,
          finishedAt: clock(),
          notes: [...current.notes, `${stage}: exhausted ${LIMITS.maxAttemptsPerStage} attempts`],
        },
        reason:
          `Stage "${stage}" failed after ${LIMITS.maxAttemptsPerStage} attempts. ` +
          'A blocked check is not a pass.',
      };
    }
  }

  return {
    ok: true,
    manifest: { ...current, state: 'accepted', currentStage: null, finishedAt: clock() },
    summaries,
  };
};
