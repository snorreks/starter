import { describe, expect, it } from 'bun:test';
import { verifyRunnerOutput, waitForExecution } from './execution.ts';

describe('runner output verification', () => {
  it('rejects foreign object keys and mismatched hashes', () => {
    const expected = {
      jobId: 'job_a',
      attemptId: 'attempt_a',
      outputKey: 'jobs/job_a/attempts/attempt_a.mp4',
      outputBytes: 4,
      outputSha256: 'a'.repeat(64),
    };
    expect(verifyRunnerOutput(expected, { ...expected, bytes: 4, sha256: 'a'.repeat(64) })).toBe(
      true,
    );
    expect(
      verifyRunnerOutput(expected, {
        ...expected,
        outputKey: 'jobs/job_b/output',
        bytes: 4,
        sha256: 'a'.repeat(64),
      }),
    ).toBe(false);
    expect(verifyRunnerOutput(expected, { ...expected, bytes: 4, sha256: 'b'.repeat(64) })).toBe(
      false,
    );
  });
});

describe('Cloud Run execution polling budgets', () => {
  const dispatch = (state: string | null) => ({
    dispatch: async () => ({ execution: 'execution', accepted: true }),
    find: async () => (state ? { execution: 'execution', state } : null),
  });

  it('stops at the injected deadline when an execution stays active', async () => {
    let now = 0;
    await expect(
      waitForExecution({
        dispatch: dispatch(null),
        jobId: 'job_a',
        attemptId: 'attempt_a',
        deadlineMs: 3,
        now: () => now,
        pollMs: 2,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toThrow('deadline exceeded');
  });

  it('honors cancellation before polling again', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForExecution({
        dispatch: dispatch(null),
        jobId: 'job_a',
        attemptId: 'attempt_a',
        deadlineMs: 100,
        signal: controller.signal,
        now: () => 0,
      }),
    ).rejects.toThrow('cancelled');
  });
});
