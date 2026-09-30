// scripts/src/contracts/pipeline.test.ts
//
// Deterministic lifecycle coverage.
//
// This is the suite that lets CI verify the contract pipeline without a model
// provider, an API key or a network. A scripted adapter drives every branch:
// success, retry-then-success, exhausted retries, a non-retryable failure, an
// adapter that throws, and resumption from a persisted manifest.
//
// Note the manifest shape: per-stage `status`, not a flat `attempts` map. The flat
// map could not distinguish "tried and succeeded" from "tried and failed", and
// resume treated both as done. `runner.test.ts` covers that regression directly;
// this file covers the surrounding lifecycle.

import { describe, expect, test } from 'bun:test';
import {
  createManifest,
  LIMITS,
  MODES,
  makeRunId,
  type RunManifest,
  resumeManifest,
  runContract,
  type Stage,
  type StageAdapter,
  type StageEvidence,
  type StageOutcome,
} from '../src/contracts/runner.ts';

const T0 = 1_760_000_000_000;
const REVISION = 'rev-under-test';

/**
 * A clock frozen at the manifest's start time.
 *
 * Every test builds its manifest at `T0`; running it against the real wall clock
 * would place the run instantly past its budget. Determinism here is the point,
 * so the clock is part of the fixture.
 */
const frozenClock = (): number => T0;

const passingEvidence = (): StageEvidence => ({
  kind: 'verification',
  command: 'bun run test:all',
  exitCode: 0,
  sourceRevision: REVISION,
  recordedAt: T0,
});

/** An adapter that behaves exactly as told, and records what it was asked. */
const scriptedAdapter = (
  script: Partial<Record<Stage, StageOutcome[]>>,
  options: { throwOn?: Stage } = {},
): StageAdapter & { calls: Stage[] } => {
  const calls: Stage[] = [];
  const cursors = new Map<Stage, number>();

  return {
    calls,
    async runStage(stage, _manifest) {
      calls.push(stage);
      if (options.throwOn === stage) {
        throw new Error(`adapter exploded during ${stage}`);
      }
      const scripted = script[stage];
      if (scripted !== undefined) {
        const index = cursors.get(stage) ?? 0;
        cursors.set(stage, index + 1);
        return scripted[index] ?? scripted[scripted.length - 1] ?? { ok: true, summary: 'ok' };
      }
      return {
        ok: true,
        summary: `${stage} ok`,
        ...(stage === 'verify' ? { evidence: passingEvidence() } : {}),
      };
    },
  };
};

/** A manifest with some stages already proven. */
const partwayThrough = (
  contractId: string,
  succeeded: readonly Stage[],
  overrides: Partial<RunManifest> = {},
): RunManifest => {
  const base = createManifest(contractId, 'standard', T0, {
    sourceRevision: REVISION,
    ...overrides,
  });
  return {
    ...base,
    ...overrides,
    state: 'in_progress',
    stages: Object.fromEntries(
      base.plannedStages.map((stage) => [
        stage,
        succeeded.includes(stage)
          ? { stage, status: 'succeeded' as const, attempts: 1 }
          : { stage, status: 'pending' as const, attempts: 0 },
      ]),
    ),
  };
};

describe('run identity', () => {
  test('is deterministic for the same inputs', () => {
    expect(makeRunId('C-1-notes', T0)).toBe(makeRunId('C-1-notes', T0));
  });

  test('differs by contract and by time', () => {
    expect(makeRunId('C-1-a', T0)).not.toBe(makeRunId('C-1-b', T0));
    expect(makeRunId('C-1-a', T0)).not.toBe(makeRunId('C-1-a', T0 + 1));
  });

  test('strips characters that would break a path', () => {
    expect(makeRunId('../../etc/passwd', T0)).toBe(`run-${T0.toString(36)}-etcpasswd`);
  });
});

describe('modes', () => {
  test('standard mode implements and verifies without a critique round', () => {
    expect(MODES.standard).toEqual(['prepare', 'implement', 'verify', 'accepted']);
  });

  test('full mode is a superset that adds the design and review rounds', () => {
    // Typed as Stage[] so a typo in the list is a type error rather than a runtime
    // expectation that silently passes on a string.
    const extra: readonly Stage[] = ['write', 'critique', 'review'];
    for (const stage of extra) {
      expect(MODES.full).toContain(stage);
      expect(MODES.standard).not.toContain(stage);
    }
  });
});

describe('lifecycle', () => {
  test('standard mode runs its work stages in order and accepts', async () => {
    const adapter = scriptedAdapter({});
    const result = await runContract(
      createManifest('C-1', 'standard', T0, { sourceRevision: REVISION }),
      adapter,
      frozenClock,
    );

    expect(result.ok).toBe(true);
    // `accepted` is a marker the runner sets, not a stage an adapter performs.
    expect(adapter.calls).toEqual(['prepare', 'implement', 'verify']);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.state).toBe('accepted');
    expect(result.manifest.currentStage).toBeNull();
    expect(result.manifest.finishedAt).toBeDefined();
  });

  test('full mode performs every stage it declares', async () => {
    const adapter = scriptedAdapter({});
    const result = await runContract(
      createManifest('C-1f', 'full', T0, { sourceRevision: REVISION }),
      adapter,
      frozenClock,
    );

    expect(result.ok).toBe(true);
    expect(adapter.calls).toEqual([
      'prepare',
      'write',
      'critique',
      'implement',
      'review',
      'verify',
    ]);
  });

  test('retries a retryable failure and then succeeds', async () => {
    const adapter = scriptedAdapter({
      verify: [
        { ok: false, summary: 'flaky', retryable: true },
        { ok: true, summary: 'passed on retry', evidence: passingEvidence() },
      ],
    });

    const result = await runContract(
      createManifest('C-2', 'standard', T0, { sourceRevision: REVISION }),
      adapter,
      frozenClock,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.stages.verify?.attempts).toBe(2);
    expect(result.manifest.stages.verify?.status).toBe('succeeded');
    expect(result.summaries.verify).toBe('passed on retry');
  });

  test('blocks after exhausting the retry budget, and does not report success', async () => {
    const adapter = scriptedAdapter({
      verify: [{ ok: false, summary: 'still broken', retryable: true }],
    });

    const result = await runContract(
      createManifest('C-3', 'standard', T0, { sourceRevision: REVISION }),
      adapter,
      frozenClock,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.manifest.state).toBe('blocked');
    expect(result.manifest.stages.verify?.attempts).toBe(LIMITS.maxAttemptsPerStage);
    expect(result.manifest.stages.verify?.status).toBe('failed');
    expect(result.reason).toContain('not a pass');
  });

  test('does not retry a non-retryable failure', async () => {
    const adapter = scriptedAdapter({
      implement: [{ ok: false, summary: 'spec is wrong', retryable: false }],
    });

    const result = await runContract(
      createManifest('C-4', 'standard', T0, { sourceRevision: REVISION }),
      adapter,
      frozenClock,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.manifest.stages.implement?.attempts).toBe(1);
    expect(result.reason).toContain('not retryable');
  });

  test('treats an adapter that throws as a failed attempt, not a crash', async () => {
    const adapter = scriptedAdapter({}, { throwOn: 'implement' });
    const result = await runContract(
      createManifest('C-5', 'standard', T0, { sourceRevision: REVISION }),
      adapter,
      frozenClock,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.manifest.state).toBe('blocked');
    expect(result.manifest.stages.implement?.attempts).toBe(LIMITS.maxAttemptsPerStage);
    expect(result.manifest.stages.implement?.status).toBe('failed');
  });

  test('stops at the run deadline', async () => {
    let calls = 0;
    const clock = (): number => {
      calls += 1;
      return calls === 1 ? T0 : T0 + LIMITS.maxRunMs + 1;
    };

    const result = await runContract(
      createManifest('C-6', 'standard', T0, { sourceRevision: REVISION }),
      scriptedAdapter({}),
      clock,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('budget');
  });
});

describe('resumption', () => {
  test('resumes at the first stage that has not succeeded', async () => {
    // prepare and implement are proven; verify is not.
    const adapter = scriptedAdapter({});
    const result = await runContract(
      resumeManifest(partwayThrough('C-7', ['prepare', 'implement'])),
      adapter,
      frozenClock,
    );

    expect(adapter.calls).toEqual(['verify']);
    expect(result.ok).toBe(true);
    expect(result.manifest.state).toBe('accepted');
  });

  test('a stage that has attempts but no success is still run', async () => {
    // The exact shape the old flat `attempts` map produced: a count with no
    // outcome. It must not be mistaken for completion.
    const stale: RunManifest = {
      ...partwayThrough('C-7b', ['prepare']),
      stages: {
        prepare: { stage: 'prepare', status: 'succeeded', attempts: 1 },
        implement: { stage: 'implement', status: 'failed', attempts: 2 },
        verify: { stage: 'verify', status: 'pending', attempts: 0 },
        accepted: { stage: 'accepted', status: 'pending', attempts: 0 },
      },
    };

    const adapter = scriptedAdapter({});
    await runContract(resumeManifest(stale), adapter, frozenClock);

    expect(adapter.calls).toEqual(['implement', 'verify']);
  });

  test('a fully completed resume does no work and stays accepted', async () => {
    const complete: RunManifest = {
      ...partwayThrough('C-8', ['prepare', 'implement', 'verify', 'accepted']),
      state: 'accepted',
      currentStage: null,
      stages: {
        prepare: { stage: 'prepare', status: 'succeeded', attempts: 1 },
        implement: { stage: 'implement', status: 'succeeded', attempts: 1 },
        verify: {
          stage: 'verify',
          status: 'succeeded',
          attempts: 1,
          evidence: passingEvidence(),
        },
        accepted: { stage: 'accepted', status: 'succeeded', attempts: 1 },
      },
    };

    const adapter = scriptedAdapter({});
    const result = await runContract(resumeManifest(complete), adapter, frozenClock);

    expect(adapter.calls).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('resuming a cancelled run does not silently revive it', () => {
    const cancelled: RunManifest = {
      ...createManifest('C-9', 'standard', T0),
      state: 'cancelled',
      currentStage: null,
    };

    const resumed = resumeManifest(cancelled);
    expect(resumed.state).toBe('cancelled');
    expect(resumed.currentStage).toBeNull();
  });

  test('resuming a dry run does not promote it to accepted', async () => {
    const dry = createManifest('C-10', 'standard', T0, {
      dryRun: true,
      sourceRevision: REVISION,
    });
    const first = await runContract(dry, scriptedAdapter({}), frozenClock);
    expect(first.manifest.state).toBe('dry_run');

    // Resume again: the runner must refuse to treat a dry run as acceptance.
    const second = await runContract(
      resumeManifest(first.manifest),
      scriptedAdapter({}),
      frozenClock,
    );
    expect(second.ok).toBe(true);
    expect(second.manifest.state).toBe('dry_run');
  });
});

describe('authority', () => {
  test('the runner has no merge or deploy capability', () => {
    // Guard the shape of the feature, not just its absence: if a stage list ever
    // gains a publish step, this fails.
    expect(
      Object.values(MODES)
        .flat()
        .some((stage) => /merge|deploy|publish|release/.test(stage)),
    ).toBe(false);
  });
});
