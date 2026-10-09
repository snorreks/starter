import { describe, expect, it, test } from 'bun:test';
import { buildJobRequest, createCloudRunDispatch, reconcileExecutionName } from './dispatch.ts';

describe('Cloud Run dispatch boundary', () => {
  it('uses manual redirects in workerd and refuses redirected execution lookups', async () => {
    let calls = 0;
    const dispatch = createCloudRunDispatch({
      project: 'p',
      region: 'r',
      job: 'j',
      token: async () => 'fixture-token',
      fetcher: (async (_input, init) => {
        calls += 1;
        expect(init?.redirect).toBe('manual');
        return new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example' },
        });
      }) as typeof fetch,
    });
    await expect(dispatch.dispatch('job_a', 'attempt_a')).rejects.toThrow('lookup failed (302)');
    expect(calls).toBe(1);
  });
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

it('records an accepted execution when the operation remains incomplete beyond the polling bound', async () => {
  let accepted = false;
  let polls = 0;
  const execution = 'projects/p/locations/r/jobs/j/executions/e1';
  const dispatch = createCloudRunDispatch({
    project: 'p',
    region: 'r',
    job: 'j',
    token: async () => 'token',
    deadlineMs: 1,
    fetcher: (async (input) => {
      const url = String(input);
      if (url.includes('/executions?')) {
        return Response.json({
          executions: accepted
            ? [
                {
                  name: execution,
                  template: { containers: [{ args: ['job_a', 'attempt_a'] }] },
                },
              ]
            : [],
        });
      }
      if (url.endsWith(':run')) {
        accepted = true;
        return Response.json({ name: 'projects/p/locations/r/operations/op1' });
      }
      polls += 1;
      return Response.json({ done: false, metadata: { name: 'not-an-execution' } });
    }) as typeof fetch,
  });
  expect(await dispatch.dispatch('job_a', 'attempt_a')).toEqual({ execution, accepted: true });
  expect(polls).toBe(6);
});

/** Cloud Run v2 executions report progress through conditions, never a top-level state. */
const executionPort = (execution: Record<string, unknown>) =>
  createCloudRunDispatch({
    project: 'p',
    region: 'r',
    job: 'j',
    token: async () => 'token',
    fetcher: (async (input) => {
      if (String(input).includes('/executions?')) {
        return Response.json({
          executions: [
            {
              name: 'projects/p/locations/r/jobs/j/executions/e1',
              template: { containers: [{ args: ['job_a', 'attempt_a'] }] },
              ...execution,
            },
          ],
        });
      }
      throw new Error(`Unexpected Cloud Run request: ${String(input)}`);
    }) as typeof fetch,
  });

test.each([
  [
    'a finished execution is not pending',
    { conditions: [{ type: 'Completed', state: 'CONDITION_SUCCEEDED' }] },
    'SUCCEEDED',
  ],
  [
    'a failed attempt is not pending',
    { conditions: [{ type: 'Completed', state: 'CONDITION_FAILED' }] },
    'FAILED',
  ],
  [
    'a cancelled execution is distinguishable from a failure',
    {
      conditions: [{ type: 'Completed', state: 'CONDITION_FAILED', executionReason: 'CANCELLED' }],
    },
    'CANCELLED',
  ],
  [
    'a running execution stays pending',
    { conditions: [{ type: 'Completed', state: 'CONDITION_RECONCILING' }] },
    'PENDING',
  ],
  [
    'an execution without a Completed condition stays pending',
    { conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }] },
    'PENDING',
  ],
  ['an execution without conditions stays pending', {}, 'PENDING'],
])('%s', async (_name, conditions, expected) => {
  expect(await executionPort(conditions).find('job_a', 'attempt_a')).toEqual({
    execution: 'projects/p/locations/r/jobs/j/executions/e1',
    state: expected,
  });
});
