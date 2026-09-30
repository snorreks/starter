// scripts/src/lib/contract/pipeline.test.ts
//
// Deterministic lifecycle coverage.
//
// This is the test that lets CI verify the contract pipeline without a model
// provider, an API key, or a network. A fake adapter drives every branch:
// success, retry-then-success, exhausted retries, a non-retryable failure, an
// adapter that throws, and resumption from a persisted manifest.

import { describe, expect, test } from 'bun:test';
import {
  LIMITS,
  MODES,
  createManifest,
  makeRunId,
  resumeManifest,
  runContract,
  type RunManifest,
  type Stage,
  type StageAdapter,
  type StageOutcome,
} from './runner.ts';

const T0 = 1_760_000_000_000;

/**
 * A clock frozen at the manifest's start time.
 *
 * Every test builds its manifest at `T0`; running it against the real wall
 * clock would place the run instantly past its budget. Determinism here is the
 * point, so the clock is part of the fixture.
 */
const frozenClock = (): number => T0;

/** An adapter that behaves exactly as told, and records what it was asked. */
const scriptedAdapter = (
  script: Partial<Record<Stage, StageOutcome[]>>,
  options: { throwOn?: Stage } = {},
): StageAdapter & { calls: Stage[] } => {
  const calls: Stage[] = [];
  const cursors = new Map<Stage, number>();

  return {
    calls,
    async runStage(stage, manifest) {
      calls.push(stage);
      if (options.throwOn === stage) {
        throw new Error(`adapter exploded during ${stage}`);
      }
      const outcomes = script[stage];
      if (outcomes === undefined) {
        return { ok: true, summary: `${stage} ok` };
      }
      const index = cursors.get(stage) ?? 0;
      cursors.set(stage, index + 1);
      void manifest;
      return outcomes[index] ?? outcomes[outcomes.length - 1] ?? { ok: true, summary: 'ok' };
    },
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

  test('full mode is a superset that adds the write stage', () => {
    expect(MODES.full).toContain('write');
    expect(MODES.standard).not.toContain('write');
  });
});

describe('lifecycle', () => {
  test('standard mode runs its stages in order and accepts', async () => {
    const adapter = scriptedAdapter({});
    const result = await runContract(createManifest('C-1', 'standard', T0), adapter, frozenClock);

    expect(result.ok).toBe(true);
    expect(adapter.calls).toEqual(['prepare', 'implement', 'verify', 'accepted']);
    if (!result.ok) return;
    expect(result.manifest.state).toBe('accepted');
    expect(result.manifest.currentStage).toBeNull();
    expect(result.manifest.finishedAt).toBeDefined();
  });

  test('retries a retryable failure and then succeeds', async () => {
    const adapter = scriptedAdapter({
      verify: [
        { ok: false, summary: 'flaky', retryable: true },
        { ok: true, summary: 'passed on retry' },
      ],
    });

    const result = await runContract(createManifest('C-2', 'standard', T0), adapter, frozenClock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.attempts.verify).toBe(2);
    expect(result.summaries.verify).toBe('passed on retry');
  });

  test('blocks after exhausting the retry budget, and does not report success', async () => {
    const adapter = scriptedAdapter({
      verify: [{ ok: false, summary: 'still broken', retryable: true }],
    });

    const result = await runContract(createManifest('C-3', 'standard', T0), adapter, frozenClock);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.manifest.state).toBe('blocked');
    expect(result.manifest.attempts.verify).toBe(LIMITS.maxAttemptsPerStage);
    expect(result.reason).toContain('not a pass');
  });

  test('does not retry a non-retryable failure', async () => {
    const adapter = scriptedAdapter({
      implement: [{ ok: false, summary: 'spec is wrong', retryable: false }],
    });

    const result = await runContract(createManifest('C-4', 'standard', T0), adapter, frozenClock);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.manifest.attempts.implement).toBe(1);
    expect(result.reason).toContain('not retryable');
  });

  test('treats an adapter that throws as a failed attempt, not a crash', async () => {
    const adapter = scriptedAdapter({}, { throwOn: 'implement' });
    const result = await runContract(createManifest('C-5', 'standard', T0), adapter, frozenClock);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.manifest.state).toBe('blocked');
    expect(result.manifest.attempts.implement).toBe(LIMITS.maxAttemptsPerStage);
  });

  test('stops at the run deadline', async () => {
    // A clock that jumps past the budget on the first call.
    let calls = 0;
    const clock = (): number => {
      calls += 1;
      return calls === 1 ? T0 : T0 + LIMITS.maxRunMs + 1;
    };

    const result = await runContract(createManifest('C-6', 'standard', T0), scriptedAdapter({}), clock);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('budget');
  });
});

describe('resumption', () => {
  test('resumes at the first stage that has not succeeded', async () => {
    // A manifest as persisted mid-run: prepare and implement done, verify not.
    const interrupted: RunManifest = {
      ...createManifest('C-7', 'standard', T0, 'run-fixed'),
      state: 'in_progress',
      attempts: { prepare: 1, implement: 1 },
      currentStage: 'verify',
    };

    const adapter = scriptedAdapter({});
    const result = await runContract(resumeManifest(interrupted), adapter, frozenClock);

    expect(adapter.calls).toEqual(['verify', 'accepted']);
    expect(result.ok).toBe(true);
  });

  test('a fully completed resume does no work and stays accepted', async () => {
    const complete: RunManifest = {
      ...createManifest('C-8', 'standard', T0, 'run-fixed'),
      state: 'accepted',
      attempts: { prepare: 1, implement: 1, verify: 1, accepted: 1 },
      currentStage: null,
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
});

describe('authority', () => {
  test('the runner has no merge or deploy capability', async () => {
    // Guard against the shape of the feature, not just its absence: if a stage
    // list ever gains a publish step, this fails.
    expect(Object.values(MODES).flat().some((stage) => /merge|deploy|publish|release/.test(stage))).toBe(
      false,
    );
  });
});
