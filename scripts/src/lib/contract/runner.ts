// scripts/src/lib/contract/runner.ts
//
// The contract pipeline: a resumable, bounded state machine.
//
// The defect this file is rewritten around: **completed stages were defined as
// "stages with any attempt count"**. A failed stage has an attempt count, so
// resume skipped it and the run reached `accepted` — a run that had a broken
// implementation stage reported itself as verified. The state model now records
// an explicit per-stage status, and only `succeeded` is ever skipped.
//
// Two further rules, both enforced here rather than in the CLI:
//
//   * **A dry run cannot become accepted.** `--dry-run` ends in `dry_run`, which
//     is not a success. Acceptance additionally requires deterministic evidence
//     bound to the current source revision; a model's prose is not a test result.
//   * **`maxStageMs` is enforced against the awaited adapter.** The constant was
//     declared and never applied, so a stage that hung ran until the process died.
//
// Deliberately small: the source project had ~40 modules, a manifest store, a
// worktree orchestrator, an escalation ladder and a usage ledger. What is kept is
// run identity, a fixed stage order, bounded retries and timeouts, and an
// injectable adapter.
//
// There is deliberately no ability to merge or deploy. Creating a contract does
// not authorise publishing its result, and the runner has no code path that could.

export const STAGES = [
  'prepare',
  'write',
  'critique',
  'implement',
  'review',
  'verify',
  'accepted',
] as const;

export type Stage = (typeof STAGES)[number];

/** Stages an adapter can actually be asked to perform. `accepted` is the marker. */
export const WORK_STAGES: readonly Stage[] = STAGES.filter((stage) => stage !== 'accepted');

export type RunMode = 'standard' | 'full';

/**
 * Stage order per mode.
 *
 * `full` previously claimed in its own comments to include critique and review
 * and did not. It does now, which is what makes it worth opting into: for
 * architecture, auth/permissions, migrations and cross-platform work, the
 * critique round is where the design gets caught, and the review round is where
 * an implementation that satisfies the letter of the plan gets rejected.
 */
export const MODES: Record<RunMode, readonly Stage[]> = {
  standard: ['prepare', 'implement', 'verify', 'accepted'],
  full: ['prepare', 'write', 'critique', 'implement', 'review', 'verify', 'accepted'],
};

/** Terminal and non-terminal run states. */
export type RunState = 'pending' | 'in_progress' | 'accepted' | 'blocked' | 'cancelled' | 'dry_run';

/**
 * States a resume will not reopen.
 *
 * `blocked` is deliberately **not** here. A blocked run is the resumable case —
 * that is what "blocked" means. Treating it as final makes `--resume` a no-op for
 * precisely the runs that need it.
 */
export const FINAL_STATES: readonly RunState[] = ['accepted', 'cancelled', 'dry_run'];

/**
 * Per-stage status.
 *
 * `cancelled` is distinct from `failed` so an interrupted run can be told apart
 * from a broken one on resume: a cancelled stage should be retried, a failed one
 * is either retried within its budget or reported.
 */
export type StageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * What a stage produced that can be checked without trusting the stage.
 *
 * Acceptance requires this. `summary` is model prose and is deliberately kept out
 * of it: a model that says "all tests pass" is not a test result.
 */
export interface StageEvidence {
  kind: 'plan' | 'review' | 'verification';
  /** The command that was run, when the stage ran one. */
  command?: string;
  /** Its exit status. Zero is required for `verification`. */
  exitCode?: number;
  /** Source revision this evidence is bound to. */
  sourceRevision?: string;
  recordedAt: number;
}

export interface StageRecord {
  stage: Stage;
  status: StageStatus;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  summary?: string;
  evidence?: StageEvidence;
  error?: string;
}

export interface RunManifest {
  runId: string;
  contractId: string;
  mode: RunMode;
  /** True when this run must never reach `accepted`. */
  dryRun: boolean;
  plannedStages: readonly Stage[];
  /** Per-stage state. The authority on what may be skipped. */
  stages: Record<string, StageRecord>;
  currentStage: Stage | null;
  state: RunState;
  /** Wall-clock deadline for the whole run. */
  deadline: number;
  startedAt: number;
  finishedAt?: number;
  /** Free-form notes. Never used to make a decision. */
  notes: string[];
  /** How many times this run has been invoked, across resumes. */
  invocations: number;
  /** Current source revision. Acceptance evidence is bound to it. */
  sourceRevision?: string;
}

/**
 * Bounds. Every one of these is a number, not a policy string, and all are applied.
 *
 * The retry budget is **per invocation** and `maxInvocations` bounds the lifetime
 * total. A lifetime-only per-stage budget cannot work: a stage that failed twice
 * would have no attempts left, so `--resume` could never retry the one stage that
 * failed, which is the only reason to resume. A per-invocation budget with no
 * lifetime cap lets an operator resume forever. Both numbers together bound it.
 */
export const LIMITS = {
  maxAttemptsPerStage: 2,
  maxInvocations: 5,
  maxRunMs: 30 * 60_000,
  maxStageMs: 10 * 60_000,
} as const;

/** A run identity. Deterministic given the same inputs, which makes it testable. */
export const makeRunId = (contractId: string, now: number): string =>
  `run-${now.toString(36)}-${contractId.replace(/[^a-z0-9-]/gi, '').toLowerCase()}`;

export type StageOutcome =
  | { ok: true; summary: string; evidence?: StageEvidence }
  | { ok: false; summary: string; retryable: boolean };

/**
 * What actually performs a stage.
 *
 * `signal` is real and is aborted on timeout or cancellation. An adapter that
 * ignores it still gets its promise rejected — the runner stops waiting — but the
 * work is still running, which is why `cancel()` exists.
 */
export interface StageAdapter {
  runStage(
    stage: Stage,
    manifest: RunManifest,
    options: { signal: AbortSignal; attempt: number },
  ): Promise<StageOutcome>;
  /** Best-effort teardown of in-flight work. Called after a timeout or abort. */
  cancel?(): void;
}

export type RunResult =
  | { ok: true; manifest: RunManifest; summaries: Record<string, string> }
  | { ok: false; manifest: RunManifest; reason: string };

const emptyStages = (planned: readonly Stage[]): Record<string, StageRecord> =>
  Object.fromEntries(
    planned.map((stage) => [stage, { stage, status: 'pending' as StageStatus, attempts: 0 }]),
  );

export const createManifest = (
  contractId: string,
  mode: RunMode,
  now: number,
  options: { runId?: string; dryRun?: boolean; sourceRevision?: string } = {},
): RunManifest => ({
  runId: options.runId ?? makeRunId(contractId, now),
  contractId,
  mode,
  dryRun: options.dryRun ?? false,
  plannedStages: MODES[mode],
  stages: emptyStages(MODES[mode]),
  currentStage: null,
  state: 'pending',
  deadline: now + LIMITS.maxRunMs,
  startedAt: now,
  notes: [],
  invocations: 0,
  ...(options.sourceRevision === undefined ? {} : { sourceRevision: options.sourceRevision }),
});

/** Stages still needing work. `succeeded` is the only skippable status. */
export const remainingStages = (manifest: RunManifest): Stage[] =>
  manifest.plannedStages.filter(
    (stage) => stage !== 'accepted' && manifest.stages[stage]?.status !== 'succeeded',
  );

/** Is this stage proven done? Never inferred from an attempt count. */
export const stageSucceeded = (manifest: RunManifest, stage: Stage): boolean =>
  manifest.stages[stage]?.status === 'succeeded';

/**
 * Resume a run from a persisted manifest.
 *
 * Resuming is a first-class path: an interrupted run continues where it stopped.
 *
 * The prior implementation filtered `plannedStages` by `attempts[stage] ===
 * undefined`, so every attempted stage — including a failed one — was treated as
 * done. That is the whole bug; the filter is now on `status === 'succeeded'`.
 *
 * A run in a terminal state is returned unchanged. Resetting `state`
 * unconditionally would turn a cancelled run back into a live one.
 */
export const resumeManifest = (manifest: RunManifest): RunManifest => {
  if (FINAL_STATES.includes(manifest.state)) {
    return manifest;
  }

  const remaining = remainingStages(manifest);
  return {
    ...manifest,
    state: 'in_progress',
    currentStage: remaining[0] ?? null,
    finishedAt: undefined,
  };
};

const withStage = (
  manifest: RunManifest,
  stage: Stage,
  patch: Partial<StageRecord>,
): RunManifest => ({
  ...manifest,
  currentStage: stage,
  state: 'in_progress',
  stages: {
    ...manifest.stages,
    [stage]: { ...(manifest.stages[stage] as StageRecord), ...patch },
  },
});

/**
 * Run a manifest to completion.
 *
 * Stops at the first stage that fails, retries it within `maxAttemptsPerStage`,
 * and ends `blocked` when the budget is spent. A blocked run is a *reported*
 * outcome, never a pass.
 */
/** The subset of `LIMITS` a caller may narrow. Widened so a test can shrink one. */
export type LimitOverrides = {
  [K in keyof typeof LIMITS]?: number;
};

export const runContract = async (
  manifest: RunManifest,
  adapter: StageAdapter,
  clock: () => number = Date.now,
  limits: LimitOverrides = {},
): Promise<RunResult> => {
  const budget = { ...LIMITS, ...limits };
  const summaries: Record<string, string> = {};

  if (manifest.invocations >= budget.maxInvocations) {
    return {
      ok: false,
      manifest: {
        ...manifest,
        state: 'blocked',
        currentStage: null,
        finishedAt: clock(),
        notes: [
          ...manifest.notes,
          `lifetime budget of ${budget.maxInvocations} invocations exhausted`,
        ],
      },
      reason:
        `This run has been invoked ${manifest.invocations} times. ` +
        'Start a new run rather than resuming, so the attempt history is visible.',
    };
  }

  let current: RunManifest = {
    ...manifest,
    invocations: manifest.invocations + 1,
  };

  for (const stage of current.plannedStages) {
    if (stage === 'accepted') {
      continue;
    }

    if (stageSucceeded(current, stage)) {
      // Resume path: only a proven stage is skipped.
      continue;
    }

    const record = current.stages[stage] as StageRecord;
    // Attempts for *this* invocation, not lifetime attempts. `record.attempts`
    // carries the history; the budget restarts so a failed stage is retried.
    let attempt = 0;
    let succeeded = false;
    let lastError = '';

    while (attempt < budget.maxAttemptsPerStage) {
      if (clock() > current.deadline) {
        return {
          ok: false,
          manifest: {
            ...current,
            state: 'blocked',
            currentStage: null,
            finishedAt: clock(),
            notes: [...current.notes, `run deadline exceeded before stage "${stage}"`],
          },
          reason: `Run exceeded its ${budget.maxRunMs / 60_000}-minute budget at stage "${stage}".`,
        };
      }

      attempt += 1;
      current = withStage(current, stage, {
        status: 'running',
        attempts: record.attempts + attempt,
        startedAt: clock(),
        error: undefined,
      });

      const outcome = await runStageWithDeadline(current, stage, adapter, clock, budget);

      if (outcome.ok) {
        summaries[stage] = outcome.summary;
        current = withStage(current, stage, {
          status: 'succeeded',
          finishedAt: clock(),
          summary: outcome.summary,
          ...(outcome.evidence === undefined ? {} : { evidence: outcome.evidence }),
        });
        succeeded = true;
        break;
      }

      lastError = outcome.summary;

      if (!outcome.retryable) {
        return {
          ok: false,
          manifest: {
            ...withStage(current, stage, {
              status: 'failed',
              attempts: record.attempts + attempt,
              finishedAt: clock(),
              error: outcome.summary,
            }),
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
          ...withStage(current, stage, {
            status: 'failed',
            attempts: record.attempts + attempt,
            finishedAt: clock(),
            error: lastError,
          }),
          state: 'blocked',
          currentStage: null,
          finishedAt: clock(),
          notes: [
            ...current.notes,
            `${stage}: exhausted ${budget.maxAttemptsPerStage} attempts this invocation ` +
              `(${record.attempts + attempt} lifetime)`,
          ],
        },
        reason:
          `Stage "${stage}" failed after ${budget.maxAttemptsPerStage} attempts. ` +
          'A blocked check is not a pass. Fix the cause and re-run with --resume.',
      };
    }
  }

  const verification = current.stages.verify;

  // Acceptance preconditions. Each of these was previously implicit.
  if (current.dryRun) {
    return {
      ok: true,
      manifest: { ...current, state: 'dry_run', currentStage: null, finishedAt: clock() },
      summaries,
    };
  }

  if (verification?.status !== 'succeeded') {
    return {
      ok: false,
      manifest: {
        ...current,
        state: 'blocked',
        currentStage: null,
        finishedAt: clock(),
        notes: [...current.notes, 'verify did not succeed'],
      },
      reason: 'The run cannot be accepted: the verify stage did not succeed.',
    };
  }

  const evidence = verification.evidence;
  const evidenceValid =
    evidence !== undefined &&
    evidence.kind === 'verification' &&
    evidence.exitCode === 0 &&
    evidence.sourceRevision !== undefined &&
    current.sourceRevision !== undefined &&
    evidence.sourceRevision === current.sourceRevision;

  if (!evidenceValid) {
    return {
      ok: false,
      manifest: {
        ...current,
        state: 'blocked',
        currentStage: null,
        finishedAt: clock(),
        notes: [
          ...current.notes,
          'verification evidence is missing, is not a passing verification, or is bound ' +
            'to a different source revision',
        ],
      },
      reason:
        'The run cannot be accepted without deterministic verification evidence bound to ' +
        `the current source revision (${current.sourceRevision ?? 'unknown'}).`,
    };
  }

  current = withStage(current, 'accepted', {
    status: 'succeeded',
    attempts: (current.stages.accepted?.attempts ?? 0) + 1,
    finishedAt: clock(),
    summary: 'all stages succeeded with verification evidence',
  });

  return {
    ok: true,
    manifest: { ...current, state: 'accepted', currentStage: null, finishedAt: clock() },
    summaries,
  };
};

type StageExecution =
  | { ok: true; summary: string; evidence?: StageEvidence }
  | { ok: false; summary: string; retryable: boolean };

/**
 * Await one stage attempt under a real deadline.
 *
 * This is the enforcement `maxStageMs` never had. Previously the constant existed
 * and nothing read it, so a stage that hung held the process indefinitely.
 *
 * On timeout the signal is aborted and `adapter.cancel()` is called, and the
 * attempt is reported as a retryable failure — a hung stage is the case retries
 * exist for, not something to report as a pass.
 */
const runStageWithDeadline = async (
  manifest: RunManifest,
  stage: Stage,
  adapter: StageAdapter,
  clock: () => number,
  budget: { [K in keyof typeof LIMITS]: number },
): Promise<StageExecution> => {
  const controller = new AbortController();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budget.maxStageMs);
    timer.unref?.();
  });

  const work = adapter
    .runStage(stage, manifest, {
      signal: controller.signal,
      attempt: manifest.stages[stage]?.attempts ?? 1,
    })
    .then<StageExecution>((outcome) => outcome)
    .catch(
      (error: unknown): StageExecution => ({
        // An adapter that throws is a failed attempt, not a crashed run.
        ok: false,
        summary: error instanceof Error ? error.message : String(error),
        retryable: !controller.signal.aborted,
      }),
    );

  const settled = await Promise.race([work, timeout]);

  if (settled === 'timeout') {
    controller.abort();
    adapter.cancel?.();
    return {
      ok: false,
      summary: `Stage "${stage}" exceeded its ${budget.maxStageMs}ms budget and was cancelled.`,
      retryable: true,
    };
  }

  clearTimeout(timer);
  void clock;
  return settled;
};
