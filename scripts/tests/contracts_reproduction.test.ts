// scripts/src/lib/contract/reproduction.test.ts
//
// The audit's recorded reproduction, expressed as a test.
//
// An isolated run of the published contract runner produced this, before any fix:
//
//   {
//     "firstState": "blocked",
//     "firstAttempts": { "prepare": 1, "implement": 1 },
//     "resumedStages": ["verify", "accepted"],
//     "secondState": "accepted"
//   }
//
// A run whose `implement` stage failed reached `accepted` on the next invocation,
// because "completed" was defined as "has an attempt count" and a failed stage has
// one.
//
// This file reproduces that scenario end to end and asserts the corrected
// behaviour, and additionally runs the old inference beside the new one so the
// difference is visible in the same output rather than asserted from memory.
//
// The old implementation is reproduced here as `completedByAttemptCount` — a local
// re-statement of the previous rule, not a copy of the old module. It exists so the
// regression is demonstrated rather than merely asserted, and so a future reader can
// see exactly what changed.

import { describe, expect, test } from 'bun:test';
import {
  createManifest,
  type RunManifest,
  resumeManifest,
  runContract,
  type Stage,
  type StageAdapter,
  type StageOutcome,
} from '../contracts/runner.ts';

const T0 = 1_700_000_000_000;
const clock = (): number => T0;

/** The previous rule, verbatim in effect: an attempt count means "done". */
const remainingByAttemptCount = (manifest: RunManifest): Stage[] =>
  manifest.plannedStages.filter(
    (stage) => stage !== 'accepted' && manifest.stages[stage]?.attempts === undefined,
  );

/** An adapter whose `implement` stage always fails retryably. */
const brokenImplement: StageAdapter = {
  async runStage(stage): Promise<StageOutcome> {
    if (stage === 'implement') {
      return { ok: false, summary: 'implement broke', retryable: true };
    }
    return { ok: true, summary: `${stage} ok` };
  },
};

describe('the recorded reproduction', () => {
  test('the old inference skips a failed implement stage on resume', () => {
    // Run 1: prepare succeeds, implement fails, the run blocks.
    const first = createManifest('C-001', 'standard', T0);

    // Faithful to the original shape: `attempts` was a `Record<string, number>` in
    // which a *missing* key meant "not yet run", and `recordAttempt` set it. So a
    // stage that has never been attempted has no entry at all.
    const afterFailure: RunManifest = {
      ...first,
      state: 'blocked',
      stages: {
        prepare: { stage: 'prepare', status: 'succeeded', attempts: 1 },
        implement: { stage: 'implement', status: 'failed', attempts: 1 },
      } as RunManifest['stages'],
    };

    // The old filter drops every attempted stage — including the failed one.
    const oldResumedStages = remainingByAttemptCount(afterFailure).filter(
      (stage) => stage !== 'accepted',
    );

    expect(oldResumedStages).toEqual(['verify']);
    expect(oldResumedStages).not.toContain('implement');
  });

  test('the current inference re-runs a failed implement stage', async () => {
    const first = await runContract(
      createManifest('C-001', 'standard', T0),
      brokenImplement,
      clock,
      { maxAttemptsPerStage: 1 },
    );

    expect(first.ok).toBe(false);
    if (first.ok) {
      throw new Error('expected the first run to be blocked');
    }
    expect(first.manifest.state).toBe('blocked');

    const seen: Stage[] = [];
    await runContract(
      resumeManifest(first.manifest),
      {
        async runStage(stage): Promise<StageOutcome> {
          seen.push(stage);
          return { ok: true, summary: `${stage} ok` };
        },
      },
      clock,
    );

    // The difference, in one assertion: the failed stage runs again.
    expect(seen).toContain('implement');
  });

  test('a run whose implementation failed cannot reach accepted', async () => {
    const result = await runContract(
      createManifest('C-002', 'standard', T0),
      brokenImplement,
      clock,
      { maxAttemptsPerStage: 1 },
    );

    expect(result.ok).toBe(false);
    expect(result.manifest.state).toBe('blocked');
    expect(result.manifest.state).not.toBe('accepted');
    // And `accepted` was never even marked, so a later resume cannot read it as
    // a stage that completed.
    expect(result.manifest.stages.accepted?.status ?? 'pending').not.toBe('succeeded');
  });
});
