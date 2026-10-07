import { describe, expect, it } from 'bun:test';
import { buildJobRequest, createCloudRunDispatch, reconcileExecutionName } from './dispatch.ts';

describe('Cloud Run dispatch boundary', () => {
  it('sends opaque ids only and uses a deterministic execution name', () => {
    const request = buildJobRequest({ jobId: 'job_abc', attemptId: 'attempt_123' });
    expect(request.overrides.containerOverrides[0]?.args).toEqual(['job_abc', 'attempt_123']);
    expect(JSON.stringify(request)).not.toContain('sample-v1');
    expect(reconcileExecutionName('job_abc', 'attempt_123')).toMatch(/^starter-encode-/);
  });

  it('refuses an execution that does not belong to the fenced attempt', () => {
    expect(() => reconcileExecutionName('../foreign', 'attempt')).toThrow();
    expect(() => buildJobRequest({ jobId: 'job_abc', attemptId: 'attempt/foreign' })).toThrow();
  });

  it('reconciles an accepted dispatch after its durable execution record fails without starting a second run', async () => {
    let postCount = 0;
    let recorded = false;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/executions?')) {
        return Response.json({
          executions: recorded
            ? [
                {
                  name: 'projects/p/locations/r/jobs/j/executions/e1',
                  state: 'EXECUTION_RUNNING',
                  template: { containers: [{ args: ['job_a', 'attempt_a'] }] },
                },
              ]
            : [],
        });
      }
      if (url.endsWith('/jobs/j:run')) {
        postCount += 1;
        expect(JSON.parse(String(init?.body))).toEqual(
          buildJobRequest({ jobId: 'job_a', attemptId: 'attempt_a' }),
        );
        recorded = true;
        return Response.json({ name: 'projects/p/locations/r/operations/op1' });
      }
      if (url.endsWith('/operations/op1')) {
        return Response.json({
          done: true,
          response: { name: 'projects/p/locations/r/jobs/j/executions/e1' },
        });
      }
      throw new Error(`Unexpected Cloud Run request: ${url}`);
    }) as typeof fetch;
    const dispatch = createCloudRunDispatch({
      project: 'p',
      region: 'r',
      job: 'j',
      token: async () => 'short-token',
      fetcher,
      deadlineMs: 50,
    });
    const started = await dispatch.dispatch('job_a', 'attempt_a');
    expect(started.execution).toBe('projects/p/locations/r/jobs/j/executions/e1');
    // Model a recording RPC failure after Cloud Run accepts. The retry reconciles
    // by the two override args and does not POST again.
    const retried = await dispatch.dispatch('job_a', 'attempt_a');
    expect(retried.execution).toBe(started.execution);
    expect(postCount).toBe(1);
  });
});
