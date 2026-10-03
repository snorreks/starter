// apps/frontend/client/src/routes/api/jobs/+server.ts
//
// `/api/jobs` — the collection. Two verbs, both thin.
//
// Thin is a specific claim: this file resolves who the caller is, validates the
// request against the shared TypeBox schema, maps a service outcome to a status
// code, and logs the write. It contains no SQL, no budget arithmetic and no
// ownership rule, because those live in `#lib/server/jobs_service.ts` and
// `@starter/jobs` where they are reachable from a server load and a scheduled
// maintenance run as well as from here.
//
// The status codes are the frozen contract:
//
//   202 accepted (new, or a replay of one this key already created)
//   400 the body or the `Idempotency-Key` is not one of the frozen shapes
//   401 no session
//   403 signed in, address not confirmed
//   409 this key was used for a different body
//   429 active / hourly / daily budget exhausted
//   503 the jobs profile is disabled for this deployment
//
// 503 is last on purpose. A deployment without a compute profile must be able to
// serve notes and auth perfectly well while answering *this* endpoint with a name
// for what is missing — not a 500, and not a 404 that reads like a wrong URL.

import { Value } from '@sinclair/typebox/value';
import {
  CreateEncodeJobSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
} from '@starter/schemas/jobs';
import { json, jsonError, readJsonBody, unauthorized } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/**
 * Byte ceiling for the create body.
 *
 * `CreateEncodeJobSchema` is two frozen enum fields, so a valid body is under a
 * hundred bytes. 4 KiB is generous for the envelope and small enough that a
 * hostile client cannot make the Worker hold anything interesting.
 */
const MAX_BODY_BYTES = 4 * 1024;

/**
 * 403 rather than 401 for an unconfirmed address.
 *
 * The session is real — this browser proved it holds a credential — but the
 * person behind it has not confirmed they own the address. Both are stated
 * separately because a view that cannot tell them apart tells a real user to wait
 * for a mail that is never coming, or to sign in again for no reason.
 */
const emailNotVerified = (): Response =>
  jsonError(403, 'email_not_verified', 'Confirm your email address before starting a job.');

const capabilityUnavailable = (detail: string): Response =>
  jsonError(503, 'jobs_profile_disabled', detail);

/**
 * Refuse a key that is absent *or* not one of the frozen shapes.
 *
 * Validated, not merely checked for presence: a key containing a space or a
 * control character is a key that two hops may normalise differently, which
 * defeats idempotency without the caller noticing. The same `IdempotencyKeySchema`
 * the browser validates against is the one enforced here, so there is one rule.
 */
const invalidKey = (): Response =>
  jsonError(
    400,
    'invalid_idempotency_key',
    `Send an ${IDEMPOTENCY_KEY_HEADER} header of 1-100 printable ASCII characters, with no spaces.`,
  );

const budgetExceeded = (detail: string): Response => jsonError(429, 'budget_exceeded', detail);

const conflict = (detail: string): Response => jsonError(409, 'idempotency_conflict', detail);

export const GET: RequestHandler = async ({ locals, url }) => {
  const user = locals.user;
  if (user === null) {
    return unauthorized();
  }

  // The list answers with the capability too. An empty list from a deployment that
  // cannot show jobs reads as "you have none", which is a different and wrong
  // statement about the same owner.
  if (locals.container.jobsProfile !== 'encode') {
    return capabilityUnavailable(
      'This deployment has the jobs profile disabled, so jobs cannot be listed here.',
    );
  }

  const service = locals.container.jobs;
  const limit = Number(url.searchParams.get('limit') ?? '');
  const page = await service.list(user.id, {
    cursor: url.searchParams.get('cursor'),
    // A non-numeric or absent limit is the service's default, not a 400: the
    // clamp in the repository is the real bound and a client asking for "the
    // usual amount" should not have to say so.
    ...(Number.isSafeInteger(limit) && limit > 0 ? { limit } : {}),
  });
  if (!page.ok) {
    return jsonError(400, page.code, page.detail);
  }
  return json(200, page.page);
};

export const POST: RequestHandler = async ({ locals, request }) => {
  // `locals.context`, not a fresh resolution: the hook already resolved this
  // request's session and trace, and a second resolution is a second identity to
  // keep in step. See `#lib/server/request_context.ts`.
  const context = locals.context;
  const user = context.user;
  if (user === null) {
    return unauthorized();
  }

  // The capability check comes before the body check. A deployment that cannot run
  // a job at all has nothing to validate a job against, and a client that fixes
  // its body and retries into the same 503 would be misled.
  if (locals.container.jobsProfile !== 'encode') {
    return capabilityUnavailable(
      'This deployment has the jobs profile disabled, so jobs cannot be started here.',
    );
  }

  if (!user.emailVerified) {
    return emailNotVerified();
  }

  // Named separately from a bad body: this header is what makes a retry safe, so a
  // client that omits or malforms it needs to be told *that*, not "validation
  // failed".
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (idempotencyKey === null || !Value.Check(IdempotencyKeySchema, idempotencyKey)) {
    return invalidKey();
  }

  const parsed = await readJsonBody(request, CreateEncodeJobSchema, {
    maxBytes: MAX_BODY_BYTES,
    // The frozen contract says 400 for an invalid body. The shared reader's
    // default is 422, which is right for most of this API; the job contract is
    // stated in the design and the two shapes are indistinguishable to a client
    // anyway, so the option exists rather than a second body reader.
    invalidStatus: 400,
  });
  if (!parsed.ok) {
    return parsed.response;
  }

  const outcome = await locals.container.jobs.create(
    user.id,
    parsed.value as { fixture: 'sample-v1'; preset: 'demo-180p-v1' },
    idempotencyKey,
  );

  if (!outcome.ok) {
    switch (outcome.code) {
      case 'idempotency_conflict':
        return conflict(outcome.detail);
      case 'budget_exceeded':
        return budgetExceeded(outcome.detail);
      case 'jobs_profile_disabled':
        return capabilityUnavailable(outcome.detail);
      case 'email_not_verified':
        return emailNotVerified();
      default:
        return jsonError(400, 'invalid_request', 'That job request is not one this API accepts.');
    }
  }

  // A write is the event worth correlating, so this is the path that logs. The
  // replay is labelled, because a client retrying and a client double-submitting
  // produce the same rows and only one of them is a duplicate.
  context.logger.write({
    logLevel: 'INFO',
    logType: 'info',
    event: 'jobs.create',
    traceId: context.traceId,
    data: { jobId: outcome.job.id, status: outcome.job.status, replayed: outcome.replayed },
  });

  // 202 for both a new job and a replay: the caller asked for a job to exist, and
  // it does. Distinguishing them in the status would invite a client to treat a
  // successful retry as a new resource and create a second one.
  return json(202, outcome.job);
};

export const PUT = (): Response => jsonError(405, 'method_not_allowed', 'Use GET or POST here.');
export const DELETE = (): Response => jsonError(405, 'method_not_allowed', 'Use GET or POST here.');
