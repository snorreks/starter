// packages/backend/jobs/src/lib/dispatch_port.test.ts
//
// The dispatch seam, including the fixture PR H will replace.
//
// There is no Workflow binding in this PR, so the *only* thing that can be
// proved here is the seam's own contract: that a dispatch carries what a Workflow
// needs and nothing more, that the instance id is derived rather than chosen, and
// that the disabled port refuses rather than pretending.
//
// The recording port below is the "test fixture at this boundary" the round-2
// prompt asks for. It is deliberately not in the package's public surface: a
// recording dispatcher shipped alongside the real one is a second
// implementation waiting to be wired up by accident.

import { describe, expect, test } from 'bun:test';
import {
  createDisabledDispatchPort,
  createWorkflowDispatchPort,
  DISPATCH_ERROR_CODES,
  type DispatchOutcome,
  type DispatchTarget,
  dispatchTargetFor,
  type WorkflowDispatchPort,
} from './dispatch_port.ts';
import { type JobRecord, workflowIdFor } from './job_repository.ts';

const target = (overrides: Partial<DispatchTarget> = {}): DispatchTarget => ({
  jobId: 'job_1',
  workflowId: workflowIdFor('job_1'),
  fixture: 'sample-v1',
  preset: 'demo-180p-v1',
  attemptId: 'attempt-1',
  ...overrides,
});

/** Records what it was asked to do and answers with whatever it was told to. */
const recordingPort = (
  answer: DispatchOutcome = { ok: true },
): WorkflowDispatchPort & { calls: DispatchTarget[] } => {
  const calls: DispatchTarget[] = [];
  return {
    calls,
    async dispatch(targetToDispatch) {
      calls.push(targetToDispatch);
      return answer;
    },
  };
};

const jobRecord = (overrides: Partial<JobRecord> = {}): JobRecord => {
  const id = overrides.id ?? 'job_1';
  return {
    id,
    ownerId: 'user_alice',
    kind: 'encode',
    status: 'pending',
    fixture: 'sample-v1',
    preset: 'demo-180p-v1',
    idempotencyKey: 'key-1',
    requestFingerprint: '{}',
    // Derived from whatever id this record carries, so an override cannot leave a
    // record whose stored Workflow id disagrees with its own id.
    workflowId: workflowIdFor(id),
    dispatchState: 'pending',
    dispatchAttempts: 0,
    dispatchError: null,
    activeAttemptId: null,
    attemptCount: 0,
    outputKey: null,
    output: null,
    errorCode: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...overrides,
  };
};

describe('the dispatch target', () => {
  test('carries the job, the instance, the fixture, the preset and the attempt — and nothing else', () => {
    const job = jobRecord({ activeAttemptId: 'attempt-1' });
    const built = dispatchTargetFor(job, 'attempt-1');

    expect(Object.keys(built).sort()).toEqual([
      'attemptId',
      'fixture',
      'jobId',
      'preset',
      'workflowId',
    ]);
    // No owner id, no idempotency key, no output key: a Workflow does not decide
    // who a job belongs to, and the more a dispatch target carries, the more of it
    // a later refactor might start treating as trusted.
    expect(built).not.toHaveProperty('ownerId');
    expect(built).not.toHaveProperty('idempotencyKey');
    expect(built).not.toHaveProperty('outputKey');
  });

  test('the instance id is derived from the job id, so a retry addresses the same instance', () => {
    const first = dispatchTargetFor(jobRecord({ id: 'job_abc' }), 'attempt-1');
    const retry = dispatchTargetFor(
      jobRecord({ id: 'job_abc', dispatchState: 'dispatch_failed', dispatchAttempts: 1 }),
      'attempt-2',
    );

    expect(first.workflowId).toBe('encode-job_abc');
    expect(retry.workflowId).toBe(first.workflowId);
    // The attempt differs — that is the fence — while the instance does not.
    expect(retry.attemptId).not.toBe(first.attemptId);
  });
});

describe('the recording fixture', () => {
  test('is called with the target and answers with what it was told to', async () => {
    const port = recordingPort();
    const built = target({ attemptId: 'attempt-7' });

    expect(await port.dispatch(built)).toEqual({ ok: true });
    expect(port.calls).toEqual([built]);
  });

  test('can report a refusal with a frozen code and no provider text', async () => {
    const port = recordingPort({
      ok: false,
      code: 'provider_unavailable',
      message: 'the workflow provider refused the request',
      retryable: true,
    });

    const outcome = await port.dispatch(target());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(DISPATCH_ERROR_CODES).toContain(outcome.code);
    // The refusal is stored on the job row, so it has to be a code this repository
    // enumerated rather than whatever a provider said.
    expect(outcome.message).not.toMatch(/https?:/);
  });
});

describe('the disabled dispatch port', () => {
  test('refuses rather than reporting success', async () => {
    // The failure this prevents: `POST /api/jobs` answering 202 for a job nothing
    // will ever run. That is invisible until somebody goes looking for the video,
    // which is the worst time to discover it.
    const outcome = await createDisabledDispatchPort().dispatch(target());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('compute_profile_disabled');
    expect(DISPATCH_ERROR_CODES).toContain(outcome.code);
  });

  test('reports the dispatch as recoverable, because the admission already committed', async () => {
    const outcome = await createDisabledDispatchPort().dispatch(target());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    // Retryable, and the reason is the whole point: the job exists in D1 and is
    // owed a dispatch, so enabling the profile and recovering is a real remedy.
    expect(outcome.retryable).toBe(true);
    expect(outcome.message).toContain('recover');
  });

  test('refuses identically for every job, so it is a capability and not a per-job error', async () => {
    const port = createDisabledDispatchPort();
    const first = await port.dispatch(target({ jobId: 'job_a', attemptId: 'attempt-1' }));
    const second = await port.dispatch(target({ jobId: 'job_b', attemptId: 'attempt-2' }));
    expect(first).toEqual(second);
  });
});

describe('the Workflow-backed dispatch port', () => {
  test('a retried admission addresses one instance, not two encodes', async () => {
    // The claim is about *identity*: `create({ id })` on an existing id is
    // addressed again by the provider. What this test can prove is the part that
    // is this repository's responsibility — that the id sent is derived from the
    // job and is byte-identical across two dispatches of the same job, and that
    // two different jobs never share one.
    const seen: Array<{ id: string; params?: unknown }> = [];
    const port = createWorkflowDispatchPort({
      async create(options) {
        seen.push({ id: options.id, params: options.params });
        return { id: options.id };
      },
    });

    const first = await port.dispatch(target({ attemptId: 'attempt-1' }));
    const retry = await port.dispatch(target({ attemptId: 'attempt-2' }));
    const other = await port.dispatch(
      target({ jobId: 'job_2', workflowId: workflowIdFor('job_2'), attemptId: 'attempt-3' }),
    );

    expect(first).toEqual({ ok: true });
    expect(retry).toEqual({ ok: true });
    expect(other).toEqual({ ok: true });

    expect(seen[0]?.id).toBe(seen[1]?.id);
    expect(seen[0]?.id).not.toBe(seen[2]?.id);
    expect(seen[0]?.id).toBe(workflowIdFor('job_1'));
  });

  test('the instance carries the frozen fixture, preset and attempt, and nothing else', async () => {
    let received: unknown;
    const port = createWorkflowDispatchPort({
      async create(options) {
        received = options.params;
        return { id: options.id };
      },
    });

    await port.dispatch(target());
    expect(received).toEqual({
      jobId: 'job_1',
      fixture: 'sample-v1',
      preset: 'demo-180p-v1',
      attemptId: 'attempt-1',
    });
    // No owner id, no storage key, no deadline: the Workflow reads those from the
    // job row it claims, and a payload that carries them is a payload that can
    // disagree with the row.
    expect(JSON.stringify(received)).not.toContain('owner');
  });

  test('an instance id that is not derived from the job id is refused', async () => {
    // One job must never be addressable by two instances: two encodes, two
    // leases, two budget spends. The derivation is the mechanism, so the port
    // checks it rather than trusting every caller to have used `dispatchTargetFor`.
    const created: string[] = [];
    const outcome = await createWorkflowDispatchPort({
      async create(options) {
        created.push(options.id);
        return { id: options.id };
      },
    }).dispatch(target({ jobId: 'job_2' }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('protocol_rejected');
    expect(created).toEqual([]);
  });

  test('a missing binding is a named capability gap, never a silent success', async () => {
    // The failure this prevents: an enabled jobs profile with no binding would
    // admit a job and answer 202 for an instance that can never exist.
    const outcome = await createWorkflowDispatchPort(undefined).dispatch(target());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('workflow_binding_missing');
    expect(outcome.retryable).toBe(true);
  });

  test('a provider that throws is retryable and carries no provider text', async () => {
    const outcome = await createWorkflowDispatchPort({
      create: async () => {
        throw new Error('wrangler exploded: key sk-live-abc123');
      },
    }).dispatch(target());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('provider_unavailable');
    expect(outcome.retryable).toBe(true);
    // The message is stored on the job row. A provider string there would be
    // unbounded, unredacted provider text in a column this repository owns.
    expect(outcome.message).not.toContain('sk-live');
    expect(outcome.message).not.toContain('wrangler');
  });

  test('a provider answering in another shape fails permanently rather than on a retry loop', async () => {
    // Retrying cannot make a peer change its answer shape, so this must not be
    // retryable: an unrecoverable dispatch retried forever is a spend.
    const shapes: unknown[] = [null, {}, { id: 42 }, { id: '' }, 'ok', { id: 'x'.repeat(0) }];
    for (const shape of shapes) {
      const outcome = await createWorkflowDispatchPort({
        create: async () => shape as { id: string },
      }).dispatch(target());
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return;
      }
      expect(outcome.code).toBe('protocol_rejected');
      expect(outcome.retryable).toBe(false);
    }
  });
});

describe('dispatching an instance that already exists', () => {
  test('an existing instance is a success, not a provider failure', async () => {
    // The local runtime throws `instance.already_exists` where the hosted one
    // returns the existing instance. Both mean the same thing — the job's instance
    // is there — and treating the throw as a failure would mark a retried dispatch
    // as `dispatch_failed` and, because the code is retryable, make recovery retry
    // the same call forever.
    const outcome = await createWorkflowDispatchPort({
      create: async () => {
        // Shaped exactly as the pinned local runtime throws it: the code is the first
        // parenthesised token of the message, and there is no `code` property at all.
        throw new Error(
          'WorkflowError: (instance.already_exists) Workflow instance with id "encode-job_1" already exists',
        );
      },
    }).dispatch(target());

    expect(outcome).toEqual({ ok: true });
  });

  test('an error that carries a declared code is honoured without parsing its message', async () => {
    const outcome = await createWorkflowDispatchPort({
      create: async () => {
        const error = new Error('a different sentence entirely');
        (error as Error & { code: string }).code = 'instance.already_exists';
        throw error;
      },
    }).dispatch(target());

    expect(outcome).toEqual({ ok: true });
  });

  test('a provider failure that merely mentions an existing instance is not a success', async () => {
    // The check is on the code, not the message: a message search would accept this
    // one, and accepting it would mean never recording a real outage.
    const outcome = await createWorkflowDispatchPort({
      create: async () => {
        const error = new Error('WorkflowError: (quota_exceeded) a quota was exceeded');
        (error as Error & { code: string }).code = 'provider_unavailable';
        throw error;
      },
    }).dispatch(target());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('provider_unavailable');
  });
});
