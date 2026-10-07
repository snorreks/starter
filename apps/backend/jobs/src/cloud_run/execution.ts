import type { DispatchPort } from './dispatch.ts';

export type ExecutionState = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'RUNNING' | 'PENDING';

/** Polls a reconciled execution with injected time and cancellation, never an open-ended wait. */
export const waitForExecution = async (options: {
  dispatch: DispatchPort;
  jobId: string;
  attemptId: string;
  deadlineMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}): Promise<ExecutionState> => {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('execution polling cancelled'));
          },
          { once: true },
        );
      }));
  const until = now() + Math.min(Math.max(options.deadlineMs, 1), 15 * 60_000);
  while (now() < until) {
    if (options.signal?.aborted) {
      throw new Error('execution polling cancelled');
    }
    const execution = await options.dispatch.find(options.jobId, options.attemptId);
    if (execution && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(execution.state)) {
      return execution.state as ExecutionState;
    }
    await sleep(Math.min(options.pollMs ?? 2_000, until - now()), options.signal);
  }
  throw new Error('Cloud Run execution polling deadline exceeded.');
};

export const verifyRunnerOutput = (
  expected: {
    jobId: string;
    attemptId: string;
    outputKey: string;
    outputBytes: number;
    outputSha256: string;
  },
  actual: { jobId: string; attemptId: string; outputKey: string; bytes: number; sha256: string },
): boolean =>
  actual.jobId === expected.jobId &&
  actual.attemptId === expected.attemptId &&
  actual.outputKey === expected.outputKey &&
  actual.bytes === expected.outputBytes &&
  actual.sha256 === expected.outputSha256 &&
  /^[a-f0-9]{64}$/.test(actual.sha256);
