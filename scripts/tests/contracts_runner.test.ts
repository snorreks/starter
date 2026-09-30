// scripts/src/lib/contract/runner.test.ts
//
// The contract state machine's correctness invariants.
//
// The test that matters is `THE DEFECT: a failed stage is never skipped on resume`.
// It is here because the defect was reproduced against the published contract
// runner before any fix:
//
//   {
//     "firstState": "blocked",
//     "firstAttempts": { "prepare": 1, "implement": 1 },
//     "resumedStages": ["verify", "accepted"],
//     "secondState": "accepted"
//   }
//
// A run whose `implement` stage failed reached `accepted` on the next invocation,
// because completion was inferred from "the stage has an attempt count" and a
// failed stage has one.

import { describe, expect, test } from 'bun:test';
import {
  createManifest,
  LIMITS,
  MODES,
  type RunManifest,
  type RunResult,
  resumeManifest,
  runContract,
  type Stage,
  type StageAdapter,
  type StageEvidence,
  type StageOutcome,
} from '../src/contracts/runner.ts';

const NOW = 1_700_000_000_000;

/**
 * Frozen at the manifest's start time.
 *
 * `NOW` is in the past relative to the real wall clock, so a run against
 * `Date.now` is instantly past its budget and every stage reports blocked. The
 * clock is part of the fixture, not an implementation detail to omit.
 */
const frozenClock = (): number => NOW;

const REVISION = 'rev-1';

const verificationEvidence = (revision: string = REVISION): StageEvidence => ({
  kind: 'verification',
  command: 'bun run test:all',
  exitCode: 0,
  sourceRevision: revision,
  recordedAt: NOW,
});

/** An adapter that succeeds everywhere, producing acceptable verify evidence. */
const passingAdapter = (
  overrides: Partial<Record<Stage, StageOutcome>> = {},
  revision: string = REVISION,
): StageAdapter => ({
  async runStage(stage): Promise<StageOutcome> {
    const override = overrides[stage];
    if (override !== undefined) {
      return override;
    }
    return {
      ok: true,
      summary: `${stage} ok`,
      ...(stage === 'verify' ? { evidence: verificationEvidence(revision) } : {}),
    };
  },
});

const neverReached = async (): Promise<StageOutcome> => {
  throw new Error('the runner reached a stage it should have skipped');
};

/**
 * Assert a run was blocked and return its narrowed failure.
 *
 * `expect(result.ok).toBe(false)` does not narrow the union for TypeScript, so
 * every `result.reason` afterwards would be a type error. Narrowing in one place
 * keeps the assertions readable.
 */
const blocked = (result: RunResult): Extract<RunResult, { ok: false }> => {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('expected the run to be blocked');
  }
  return result;
};

describe('stage state model', () => {
  test('full mode actually contains the critique and review stages', () => {
    // Its own comments claimed these; the stage list did not have them.
    expect(MODES.full).toContain('critique');
    expect(MODES.full).toContain('review');
    expect(MODES.standard).not.toContain('critique');
    expect(MODES.standard).not.toContain('review');
  });

  test('a new manifest records every planned stage as pending', () => {
    const manifest = createManifest('C-001', 'standard', NOW);
    for (const stage of manifest.plannedStages) {
      expect(manifest.stages[stage]?.status).toBe('pending');
      expect(manifest.stages[stage]?.attempts).toBe(0);
    }
  });
});

describe('acceptance preconditions', () => {
  test('a dry run ends in dry_run, never accepted', async () => {
    const manifest = createManifest('C-001', 'standard', NOW, { dryRun: true });
    const result = await runContract(manifest, passingAdapter(), frozenClock);

    expect(result.ok).toBe(true);
    expect(result.manifest.state).toBe('dry_run');
    expect(result.manifest.state).not.toBe('accepted');
  });

  test('a passing run with no verification evidence is blocked', async () => {
    // Every stage reports success, but nothing deterministic backs it.
    const noEvidence: StageAdapter = {
      async runStage(stage): Promise<StageOutcome> {
        return { ok: true, summary: `${stage} ok (prose only)` };
      },
    };

    const manifest = createManifest('C-001', 'standard', NOW, { sourceRevision: REVISION });
    const result = await runContract(manifest, noEvidence, frozenClock);

    expect(result.ok).toBe(false);
    expect(result.manifest.state).toBe('blocked');
    expect(blocked(result).reason).toContain('verification evidence');
  });

  test('evidence bound to a different source revision is refused', async () => {
    const manifest = createManifest('C-001', 'standard', NOW, { sourceRevision: 'rev-2' });
    const result = await runContract(manifest, passingAdapter({}, 'rev-1'), frozenClock);

    expect(result.ok).toBe(false);
    expect(result.manifest.state).toBe('blocked');
    expect(blocked(result).reason).toContain('source revision');
  });

  test('evidence with a non-zero exit code is refused', async () => {
    const manifest = createManifest('C-001', 'standard', NOW, { sourceRevision: REVISION });
    const result = await runContract(
      manifest,
      {
        async runStage(stage): Promise<StageOutcome> {
          return stage === 'verify'
            ? {
                ok: true,
                summary: 'verify ok',
                evidence: { ...verificationEvidence(), exitCode: 1 },
              }
            : { ok: true, summary: `${stage} ok` };
        },
      },
      frozenClock,
    );

    expect(result.ok).toBe(false);
    expect(result.manifest.state).toBe('blocked');
    expect(blocked(result).reason).toContain('verification evidence');
  });

  test('a fully evidenced run is accepted', async () => {
    const manifest = createManifest('C-001', 'standard', NOW, { sourceRevision: REVISION });
    const result = await runContract(manifest, passingAdapter(), frozenClock);

    expect(result.ok).toBe(true);
    expect(result.manifest.state).toBe('accepted');
    expect(result.manifest.stages.accepted?.status).toBe('succeeded');
  });
});

describe('resume', () => {
  test('THE DEFECT: a failed stage is never skipped on resume', async () => {
    // First run: prepare succeeds, implement fails retryably twice.
    const failing: StageAdapter = {
      async runStage(stage): Promise<StageOutcome> {
        if (stage === 'implement') {
          return { ok: false, summary: 'implement broke', retryable: true };
        }
        if (stage === 'verify') {
          return neverReached();
        }
        return { ok: true, summary: `${stage} ok` };
      },
    };

    const first = await runContract(
      createManifest('C-001', 'standard', NOW, { sourceRevision: REVISION }),
      failing,
      frozenClock,
    );

    expect(first.ok).toBe(false);
    expect(first.manifest.state).toBe('blocked');
    expect(first.manifest.stages.prepare?.status).toBe('succeeded');
    expect(first.manifest.stages.prepare?.attempts).toBe(1);
    expect(first.manifest.stages.implement?.attempts).toBe(LIMITS.maxAttemptsPerStage);
    expect(first.manifest.stages.implement?.status).toBe('failed');

    // Second run: implement is fixed. prepare is skipped because it succeeded;
    // implement must run again.
    const seen: Stage[] = [];
    const second = await runContract(
      first.manifest,
      {
        async runStage(stage): Promise<StageOutcome> {
          seen.push(stage);
          return {
            ok: true,
            summary: `${stage} ok`,
            ...(stage === 'verify' ? { evidence: verificationEvidence() } : {}),
          };
        },
      },
      frozenClock,
    );

    expect(seen).not.toContain('prepare');
    expect(seen).toContain('implement');
    expect(seen).toContain('verify');
    expect(second.manifest.state).toBe('accepted');
  });

  test('resume does not re-run a proven stage', async () => {
    const first = await runContract(
      createManifest('C-001', 'standard', NOW, { sourceRevision: REVISION }),
      {
        async runStage(stage): Promise<StageOutcome> {
          if (stage === 'verify') {
            return { ok: false, summary: 'flaky', retryable: true };
          }
          return { ok: true, summary: `${stage} ok` };
        },
      },
      frozenClock,
    );

    expect(first.manifest.state).toBe('blocked');
    expect(first.manifest.stages.prepare?.status).toBe('succeeded');
    expect(first.manifest.stages.implement?.status).toBe('succeeded');

    const seen: Stage[] = [];
    await runContract(
      first.manifest,
      {
        async runStage(stage): Promise<StageOutcome> {
          seen.push(stage);
          return {
            ok: true,
            summary: `${stage} ok`,
            ...(stage === 'verify' ? { evidence: verificationEvidence() } : {}),
          };
        },
      },
      frozenClock,
    );

    expect(seen).toEqual(['verify']);
  });

  test('dry_run and cancelled are final; blocked is not', () => {
    const base = createManifest('C-001', 'standard', NOW);

    // Resuming a dry run must not reopen it as a live run.
    const dry: RunManifest = { ...base, state: 'dry_run', currentStage: null };
    expect(resumeManifest(dry)).toEqual(dry);

    const cancelled: RunManifest = { ...base, state: 'cancelled', currentStage: null };
    expect(resumeManifest(cancelled)).toEqual(cancelled);

    // Treating `blocked` as final made --resume a no-op for exactly the runs that
    // needed it.
    const blocked: RunManifest = { ...base, state: 'blocked', currentStage: null };
    expect(resumeManifest(blocked).state).toBe('in_progress');
  });

  test('the lifetime invocation budget bounds resume', async () => {
    const exhausted: RunManifest = {
      ...createManifest('C-002', 'standard', NOW),
      state: 'blocked',
      invocations: LIMITS.maxInvocations,
    };

    let ran = false;
    const result = await runContract(
      exhausted,
      {
        async runStage(): Promise<StageOutcome> {
          ran = true;
          return { ok: true, summary: 'ok' };
        },
      },
      frozenClock,
    );

    expect(ran).toBe(false);
    expect(result.ok).toBe(false);
    expect(blocked(result).reason).toContain('invoked');
  });
});

describe('bounds', () => {
  test('a non-retryable failure blocks immediately', async () => {
    const result = await runContract(
      createManifest('C-001', 'standard', NOW),
      {
        async runStage(stage): Promise<StageOutcome> {
          if (stage === 'implement') {
            return { ok: false, summary: 'bad contract', retryable: false };
          }
          return { ok: true, summary: `${stage} ok` };
        },
      },
      frozenClock,
    );

    expect(result.ok).toBe(false);
    expect(result.manifest.stages.implement?.attempts).toBe(1);
    expect(result.manifest.stages.implement?.status).toBe('failed');
    expect(blocked(result).reason).toContain('not retryable');
  });

  test('a hanging stage is cancelled at maxStageMs instead of waiting forever', async () => {
    // `LIMITS.maxStageMs` is 10 minutes. Shrinking it through the injectable
    // budget is what makes this observable in a test rather than in production
    // ten minutes from now — and it also proves the limit is applied to the
    // awaited adapter, which is exactly what was declared and never read before.
    let cancelled = false;
    let sawAbort = false;

    const adapter: StageAdapter = {
      cancel: () => {
        cancelled = true;
      },
      async runStage(_stage, _manifest, { signal }): Promise<StageOutcome> {
        // Never resolves on its own. Only the runner's deadline ends this.
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve();
          });
        });
        return { ok: false, summary: 'aborted', retryable: true };
      },
    };

    const result = await runContract(
      createManifest('C-001', 'standard', NOW),
      adapter,
      frozenClock,
      { maxStageMs: 50, maxAttemptsPerStage: 1 },
    );

    expect(result.ok).toBe(false);
    expect(result.manifest.state).toBe('blocked');
    // The retry budget is exhausted, and the reason the attempt failed is the
    // deadline — which is what distinguishes a hang from a normal failure.
    expect(result.manifest.stages.prepare?.status).toBe('failed');
    expect(result.manifest.stages.prepare?.error).toContain('50ms budget');
    expect(cancelled).toBe(true);
    expect(sawAbort).toBe(true);
  }, 10_000);

  test('the run deadline is enforced before any stage runs', async () => {
    let ran = false;
    const result = await runContract(
      { ...createManifest('C-001', 'standard', NOW), deadline: NOW - 1 },
      {
        async runStage(): Promise<StageOutcome> {
          ran = true;
          return { ok: true, summary: 'ok' };
        },
      },
      () => NOW,
    );

    expect(ran).toBe(false);
    expect(result.ok).toBe(false);
    expect(blocked(result).reason).toContain('budget');
  });
});
