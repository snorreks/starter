// apps/frontend/client/src/lib/server/jobs_bindings.test.ts
//
// The two binding adapters, at the boundary the web app actually controls.
//
// What is worth testing here is not "does the adapter call R2" — that is R2's test —
// but the three refusals and the one mapping the adapters are responsible for:
//
//   * a re-dispatch of an instance that already exists is a **success**, or every
//     retry would record `dispatch_failed` and recovery would retry forever;
//   * a missing binding names `workflow_binding_missing`, not `compute_profile_disabled`;
//   * a miss in the bucket is `null`, which the service turns into
//     `output_unavailable` — never a stream for an object that is not there;
//   * a bounded `Range` is passed to R2 as an offset/length pair, so a slice cannot
//     silently become a whole-object download.
//
// The R2 fake records what it was asked for. That is the point: the adapter's job is
// to translate, and the translation is what a caller gets wrong.

import { describe, expect, test } from 'bun:test';
import { createArtifactReader, createDispatchPort } from './jobs_bindings.ts';

interface RecordedGet {
  key: string;
  options: { range?: { offset: number; length: number } } | undefined;
}

/** The slice of R2 these two adapters use, with a transcript of every read. */
const fakeBucket = (exists: boolean): { bucket: R2Bucket; reads: RecordedGet[] } => {
  const reads: RecordedGet[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });
  const bucket = {
    async get(key: string, options?: RecordedGet['options']) {
      reads.push({ key, options });
      if (!exists) {
        return null;
      }
      return { body } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
  return { bucket, reads };
};

describe('the dispatch port this Worker binds', () => {
  test('a job whose instance already exists is reported as started', async () => {
    // The local runtime throws `instance.already_exists` where the hosted one returns
    // the instance. Both mean the instance is there, which is what dispatch wanted.
    const port = createDispatchPort({
      get: async () => ({ status: async () => ({ status: 'running' }) }),
      create: async () => {
        throw new Error(
          'WorkflowError: (instance.already_exists) Workflow instance with id "encode-job_1" already exists',
        );
      },
    });
    const outcome = await port.dispatch({
      jobId: 'job_1',
      workflowId: 'encode-job_1',
      fixture: 'sample-v1',
      preset: 'demo-180p-v1',
      attemptId: 'attempt-1',
    });
    expect(outcome).toEqual({ ok: true });
  });

  test('a Worker with no workflow binding names the missing binding', async () => {
    // Not `compute_profile_disabled`: this deployment *is* configured for compute and
    // one binding is absent, which is a different problem with a different remedy.
    const outcome = await createDispatchPort(undefined).dispatch({
      jobId: 'job_1',
      workflowId: 'encode-job_1',
      fixture: 'sample-v1',
      preset: 'demo-180p-v1',
      attemptId: 'attempt-1',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('workflow_binding_missing');
    expect(outcome.retryable).toBe(true);
  });
});

describe('the artifact reader', () => {
  test('no bucket bound means no reader, rather than one that throws later', () => {
    // `readOutput` has a refusal for exactly this case; a reader that existed and
    // failed on use would turn a capability answer into a 500.
    expect(createArtifactReader(undefined)).toBeUndefined();
  });

  test('an object that is genuinely absent is null, not a stream', async () => {
    const { bucket } = fakeBucket(false);
    const reader = createArtifactReader(bucket);
    const stream = await reader?.read('media/v1/jobs/job_1/attempts/a1.mp4', null);
    // A stream for a missing object is how a retention bug becomes a truncated video
    // served with a 200.
    expect(stream).toBeNull();
  });

  test('a bounded range is translated to an offset and a length', async () => {
    const { bucket, reads } = fakeBucket(true);
    const reader = createArtifactReader(bucket);
    await reader?.read('media/v1/jobs/job_1/attempts/a1.mp4', {
      startInclusive: 100,
      endInclusive: 199,
    });
    // Inclusive end, exclusive length: the off-by-one here is a 100-byte slice
    // answering a 101-byte range, or the reverse.
    expect(reads[0]?.options?.range).toEqual({ offset: 100, length: 100 });
  });

  test('a whole-artifact read asks for no range at all', async () => {
    const { bucket, reads } = fakeBucket(true);
    const reader = createArtifactReader(bucket);
    const stream = await reader?.read('media/v1/jobs/job_1/attempts/a1.mp4', null);
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(reads[0]?.options).toBeUndefined();
  });
});
