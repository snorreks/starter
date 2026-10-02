// apps/frontend/client/src/routes/api/telemetry/+server.ts
//
// `/api/telemetry` — the browser's structured events, stored as server log records.
//
// Thin on purpose. The abuse and leak concerns (client-reported context is not
// identity, redaction before storage, per-session rate limiting, never failing the
// request) all live in `#lib/server/telemetry_service.ts`, so they are one review
// surface rather than one per route. What is left here is transport: bound the
// body, validate it, call the service, choose a status.

import { json, jsonError, readJsonBody } from '#lib/server/http.ts';
import { buildRequestContext } from '#lib/server/request_context.ts';
import {
  IngestBodySchema,
  type IngestRecord,
  isRateLimited,
  limiterKeyFor,
  MAX_BODY_BYTES,
  maybeSweep,
  storeRecord,
} from '#lib/server/telemetry_service.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
  const context = await buildRequestContext(request, locals.container);

  maybeSweep();

  // Checked before parsing, so a flood costs a map lookup rather than a JSON
  // parse. `cf-connecting-ip` is the header Cloudflare sets on every request, so
  // this does not trust a caller-supplied `X-Forwarded-For`.
  if (isRateLimited(limiterKeyFor(context, request.headers.get('cf-connecting-ip')))) {
    return jsonError(429, 'rate_limited', 'Too many log events.');
  }

  const parsed = await readJsonBody(request, IngestBodySchema, { maxBytes: MAX_BODY_BYTES });
  if (!parsed.ok) {
    return parsed.response;
  }

  const records: IngestRecord[] = Array.isArray(parsed.value)
    ? parsed.value
    : [parsed.value as IngestRecord];

  for (const record of records) {
    storeRecord(record, context);
  }

  return json(202, { accepted: records.length, rejected: 0 });
};
