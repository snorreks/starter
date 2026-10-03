// apps/frontend/client/src/routes/api/telemetry/+server.ts
//
// `/api/telemetry` — the browser's structured events, stored as server log records.
//
// Thin on purpose. The abuse and leak concerns (client-reported context is not
// identity, redaction before storage, bounded submissions, never failing the
// request) all live in `#lib/server/telemetry_service.ts`, so they are one review
// surface rather than one per route. What is left here is transport: admit or
// refuse, bound the body, validate it, store, choose a status.
//
// `locals.context` is used rather than a second `buildRequestContext`: the hook
// already resolved this request's session and trace, and resolving again would be a
// second, differently authenticated path to the same identity.

import { json, jsonError, readJsonBody } from '#lib/server/http.ts';
import {
  IngestBodySchema,
  type IngestRecord,
  ingestionAdmission,
  isRateLimited,
  limiterKeyFor,
  MAX_BODY_BYTES,
  maybeSweep,
  storeRecord,
} from '#lib/server/telemetry_service.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
  const context = locals.context;

  maybeSweep();

  const admitted = ingestionAdmission(context);
  if (!admitted.ok) {
    return jsonError(401, 'unauthorized', admitted.detail);
  }

  // Checked before parsing, so a flood costs a map lookup rather than a JSON
  // parse. `cf-connecting-ip` is the header Cloudflare sets on every request, so
  // this does not trust a caller-supplied `X-Forwarded-For`. The unit is one
  // submission, not one record — see the service.
  if (isRateLimited(limiterKeyFor(context, request.headers.get('cf-connecting-ip')))) {
    return jsonError(429, 'rate_limited', 'Too many log submissions.');
  }

  const parsed = await readJsonBody(request, IngestBodySchema, { maxBytes: MAX_BODY_BYTES });
  if (!parsed.ok) {
    return parsed.response;
  }

  const records: IngestRecord[] = Array.isArray(parsed.value)
    ? (parsed.value as IngestRecord[])
    : [parsed.value as IngestRecord];

  // A record that cannot be stored is a missing record. Notes and sign-in do not
  // fail because a log write threw — that ordering is the whole reason this
  // endpoint is best-effort, and it is only true if it is written down.
  let accepted = 0;
  for (const record of records) {
    try {
      storeRecord(record, context);
      accepted += 1;
    } catch (error) {
      context.logger.warn('telemetry.store_failed', {
        traceId: context.traceId,
        message: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  // `submitted` is what arrived and passed validation; `accepted` is what was
  // written. They differ only when a record failed to store, and reporting one
  // number for both would hide exactly that.
  return json(202, { accepted, submitted: records.length, rejected: records.length - accepted });
};
