// apps/frontend/client/src/routes/api/jobs/[id]/output/+server.ts
//
// `/api/jobs/:id/output` — the owner-checked read seam for an encoded artifact.
//
// This is the seam, not the serving. No private object store is bound in this PR,
// so the reader is absent and the endpoint answers a truthful `503` rather than a
// 200 with no bytes. What this PR does establish is everything *around* the bytes:
//
//   * ownership is checked in the same query as the id, so a guessed id answers
//     exactly as a missing one does;
//   * the four refusals are distinguishable — 404 not yours, 409 not finished,
//     410 past its retention window, 503 no store bound — because a client that
//     cannot tell "not mine" from "not ready" from "expired" will retry forever or
//     show an error the user cannot act on;
//   * `Range` is parsed by `parseByteRange`, bounded by
//     `MAX_OUTPUT_RANGE_BYTES` and validated against the artifact's real length,
//     so the serving implementation cannot be handed a range nobody checked;
//   * the response is `no-store` and never carries the private storage key.
//
// 410 rather than 404 for an expired artifact is the deliberate one: the job still
// says `succeeded`, and telling the caller the artifact is *gone* is what lets it
// stop asking.

import { jsonError, unauthorized } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

const OUTPUT_HEADERS = {
  // Private, not for a shared cache and not for the browser: this is one user's
  // artifact, and the hook applies the same policy to every `/api/*` response.
  'cache-control': 'private, no-store, max-age=0',
  // No user-supplied value reaches a header, so the policy can be strict.
  'content-security-policy': "default-src 'none'; sandbox",
  'x-content-type-options': 'nosniff',
} as const;

export const GET: RequestHandler = async ({ locals, params, request }) => {
  const user = locals.user;
  if (user === null) {
    return unauthorized();
  }

  if (locals.context?.backendProfile === 'supabase') {
    const repository = locals.applicationServices?.jobs;
    if (!repository || locals.applicationServices?.identity.user.id !== user.id) {
      return unauthorized();
    }
    const job = await repository.getForOwner(params.id);
    if (job === null) {
      return jsonError(404, 'not_found', 'That job does not exist.');
    }
    return job.outputAvailable
      ? jsonError(503, 'output_unavailable', 'Preview dispatch is disabled pending Prompt 06.')
      : jsonError(409, 'output_not_ready', 'Preview dispatch is disabled pending Prompt 06.');
  }

  if (locals.container.jobsProfile !== 'encode') {
    return jsonError(
      503,
      'jobs_profile_disabled',
      'This deployment has the jobs profile disabled, so results cannot be served here.',
    );
  }

  const outcome = await locals.container.jobs.readOutput(
    user.id,
    params.id,
    request.headers.get('range'),
  );

  if (!outcome.ok) {
    switch (outcome.code) {
      case 'not_found':
        return jsonError(404, 'not_found', 'That job does not exist.');
      case 'output_not_ready':
        return jsonError(409, 'output_not_ready', outcome.detail);
      case 'output_expired':
        return jsonError(
          410,
          'output_expired',
          'That result has passed its 24-hour retention window.',
        );
      case 'range_not_satisfiable': {
        const response = jsonError(416, outcome.code, outcome.detail);
        response.headers.set('content-range', `bytes */${outcome.totalBytes}`);
        return response;
      }
      default:
        return jsonError(503, 'output_unavailable', outcome.detail);
    }
  }

  const { output, stream, range } = outcome;
  const contentLength =
    range === null ? output.bytes : range.endInclusive - range.startInclusive + 1;

  const headers = new Headers(OUTPUT_HEADERS);
  headers.set('content-type', 'video/mp4');
  headers.set('accept-ranges', 'bytes');
  headers.set('content-length', String(contentLength));
  // Measured by ffprobe, echoed so a player knows what it is about to fetch.
  headers.set('x-output-sha256', output.sha256);
  headers.set('x-output-duration-ms', String(output.durationMs));

  if (range === null) {
    return new Response(stream, { status: 200, headers });
  }

  // 206 with a `bytes` range the client can verify. The length is the slice, not
  // the whole artifact — a 206 whose `Content-Length` described the full object is
  // how a player ends up waiting for bytes that never arrive.
  headers.set(
    'content-range',
    `bytes ${range.startInclusive}-${range.endInclusive}/${output.bytes}`,
  );
  return new Response(stream, { status: 206, headers });
};

const getOnly = (): Response =>
  jsonError(405, 'method_not_allowed', 'Use GET here. Results are immutable once committed.');

export const POST = getOnly;
export const PUT = getOnly;
export const PATCH = getOnly;
export const DELETE = getOnly;
