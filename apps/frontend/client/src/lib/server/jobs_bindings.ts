// apps/frontend/client/src/lib/server/jobs_bindings.ts
//
// The two binding adapters the jobs domain needs from the platform: the Workflow a
// dispatch starts, and the private bucket an output is read from.
//
// Both are thin, and that is the point. PR F shipped `createJobsService` with a typed
// dispatch port and a typed artifact reader so that *this* file could be the only
// place the platform's shapes appear. Nothing below knows about sessions, and nothing
// above knows about R2 ranges — so the ownership check in `jobs_service.ts` stays
// where it is and cannot be bypassed by a route that reaches for the bucket directly.
//
// Why the web Worker holds these bindings at all
// ----------------------------------------------
// The jobs *Worker* is where the Workflows run, and it has no HTTP API. The caller is
// the web app's `POST /api/jobs`, which resolves the session, checks verification and
// admission, and then needs to start one instance. Cloudflare's cross-Worker workflow
// binding is exactly that: a reference to a named Workflow in another script,
// addressed by its deterministic instance id.
//
// The adapter is therefore a `WorkflowInstanceBinding` — `create({ id, params })` —
// and nothing more. No workflow class, no step API and no `cloudflare:workers` import
// reaches this half of the application, which is why the web Worker still builds and
// tests exactly as it did before compute existed.

import {
  createWorkflowDispatchPort,
  type WorkflowDispatchPort,
  type WorkflowInstanceBinding,
} from '@starter/jobs';
import type { JobArtifactReader, RangeRequest } from '#lib/server/jobs_service.ts';

/**
 * The `ENCODE_WORKFLOW` binding, as the dispatch port wants it.
 *
 * An absent binding produces a port that *refuses* with
 * `workflow_binding_missing` rather than `undefined`. `undefined` would fall back to
 * the disabled port and answer `compute_profile_disabled`, which names the wrong
 * missing thing: a deployment whose profile is enabled but whose binding was
 * forgotten is a configuration gap on this one binding, and the recovery sweep knows
 * how to retry that one.
 */
export const createDispatchPort = (
  binding: WorkflowInstanceBinding | undefined,
): WorkflowDispatchPort => createWorkflowDispatchPort(binding);

/**
 * The private bucket, as the output reader wants it.
 *
 * `undefined` when no bucket is bound, because there is nothing truthful to read with
 * and the service already has a refusal for it (`output_unavailable`) — which is a
 * capability answer rather than an error that reads like a bug.
 *
 * `R2ObjectBody` is consumed, not returned: the reader's contract is a
 * `ReadableStream`, and handing a live object back would let a caller hold the
 * binding's response open past the request.
 */
export const createArtifactReader = (
  bucket: R2Bucket | undefined,
): JobArtifactReader | undefined => {
  if (bucket === undefined) {
    return undefined;
  }

  return {
    async read(outputKey: string, range: RangeRequest | null) {
      const object = await bucket.get(
        outputKey,
        // No options at all for a whole object; R2's own range shape for a slice. The
        // range has already been parsed and bounded by `parseByteRange`, and the
        // offset/length pair is what R2 wants.
        range === null
          ? undefined
          : {
              range: {
                offset: range.startInclusive,
                length: range.endInclusive - range.startInclusive + 1,
              },
            },
      );
      // A miss is `null`, not an exception: the caller turns it into
      // `output_unavailable`, which is the honest answer for a row that claims an
      // artifact the store does not have.
      return object === null ? null : (object.body as ReadableStream<Uint8Array>);
    },
  };
};
