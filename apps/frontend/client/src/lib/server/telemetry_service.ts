// apps/frontend/client/src/lib/server/telemetry_service.ts
//
// Client log ingestion.
//
// Six things this is careful about, each an abuse or leak vector:
//
//   1. **Client-reported context is not identity.** Anything the browser claims
//      about itself arrives under `clientReported` and is stored as a label — and a
//      top-level `userId` in a submitted record is *also* demoted, because the
//      transport spreads a browser event into the payload and a browser event may
//      carry an id. The verified user id comes from the session, never from the
//      body: a client that could choose its own `userId` could plant misleading
//      entries in another user's log history.
//   2. **Redaction happens before storage**, not after retrieval — and the redacted
//      payload is stored. It used to be computed and then dropped, which made the
//      redaction pointless and the payload unrecoverable.
//   3. **Two bounds, two units.** A submission is capped by bytes (`MAX_BODY_BYTES`)
//      and by records (`MAX_RECORDS_PER_SUBMISSION`); the budget counts
//      *submissions*, because a browser flush sends many records in one.
//   4. **The submission budget is a best-effort brake, not accounting.** It lives in
//      an isolate-local `Map`: no durability, no sharing between isolates, no
//      cross-region meaning. Stated here because "rate limited" reads like a
//      guarantee and this is not one. Deployed ingestion additionally requires a
//      session, so the unauthenticated path exists only in local development.
//   5. **A failure to store never fails the request.** Telemetry that breaks the
//      product is worse than telemetry that is missing.
//   6. **The body's size is capped by the route**, before parsing.
//
// Validation is the route adapter's job, through `readJsonBody` with the schemas
// exported here. The service only sees records that already satisfy them, which is
// what lets `storeRecord` be unit-tested with no HTTP involved. Reading the body
// by hand inside the service would be the second code path to the same parse.

import { type Static, Type } from '@sinclair/typebox';
import { redactValue } from '@starter/logger';
import {
  type ClientReportedContext,
  ClientReportedContextSchema,
  type LogEvent,
  LogEventSchema,
} from '@starter/schemas/logging';
import type { RequestContext } from './request_context.ts';

/** Hard ceiling on one submission, in bytes. Rejected by the route before parsing. */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * Hard ceiling on how many records one submission may carry.
 *
 * A bound on records, not on bytes, because 16 KiB of well-formed small records is
 * about twenty of them — so without this a caller could send one request that
 * writes twenty log records, and the per-connection brake below would count that
 * as a single unit.
 */
export const MAX_RECORDS_PER_SUBMISSION = 20;

const WINDOW_MS = 60_000;

/**
 * Submissions allowed per window, per caller.
 *
 * Counted in submissions, and named that way, because a browser forwards a batch:
 * counting records would let one flush exhaust a minute's budget on its own.
 */
export const MAX_SUBMISSIONS_PER_WINDOW = 60;

const SWEEP_INTERVAL_MS = 5_000;

/**
 * One submitted record: the event fields plus the self-asserted context.
 *
 * Built as a single object rather than `Type.Intersect([LogEventSchema, …])`, and
 * the reason is a specification fact rather than a style preference. JSON Schema
 * intersection is a conjunction of both operands, so intersecting a closed
 * (`additionalProperties: false`) event object with anything that adds a field
 * yields "no value satisfies both" — the endpoint rejected the exact payload its
 * own transport always sends. Reusing `LogEventSchema.properties` keeps the two in
 * step, so a field added to the event is admitted here too, while `false` keeps
 * every other unknown field refused.
 */
export const IngestRecordSchema = Type.Object(
  {
    ...LogEventSchema.properties,
    clientReported: Type.Optional(ClientReportedContextSchema),
  },
  { additionalProperties: false },
);

export const IngestBodySchema = Type.Union([
  IngestRecordSchema,
  Type.Array(IngestRecordSchema, { maxItems: MAX_RECORDS_PER_SUBMISSION }),
]);

export type IngestRecord = Static<typeof IngestRecordSchema>;

/**
 * Fixed-window submission counter.
 *
 * Isolate-local by construction, and honest about it: a Worker isolate is
 * ephemeral, there is no shared state, and a determined caller gets a new isolate.
 * It is a brake on a loop, not a spending limit and not an authentication control.
 * The durable limiter in `@starter/auth` exists for the sign-in path, where the
 * limit is a security property; this endpoint is bounded by session plus these two
 * ceilings instead.
 */
const submissions = new Map<string, { count: number; resetAt: number }>();

/** Anonymous local submissions are counted by IP; Cloudflare sets this on every request. */
export const limiterKeyFor = (context: RequestContext, ip: string | null): string =>
  context.user?.id ?? `ip:${ip ?? 'unknown'}`;

/**
 * Charge one submission to a key, and say whether the caller is over budget.
 *
 * The key is charged once per request, not once per record, so the unit this
 * returns is "submissions in the last minute".
 */
export const isRateLimited = (key: string, now = Date.now()): boolean => {
  const entry = submissions.get(key);

  if (!entry || now >= entry.resetAt) {
    submissions.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > MAX_SUBMISSIONS_PER_WINDOW;
};

/** Drop expired counters so the map cannot grow without bound. */
const sweep = (now: number): void => {
  for (const [key, entry] of submissions) {
    if (now >= entry.resetAt) {
      submissions.delete(key);
    }
  }
};

/** Call before ingesting, so the counter map does not accumulate forever. */
export const maybeSweep = (now = Date.now()): void => {
  if (now % SWEEP_INTERVAL_MS < 1_000) {
    sweep(now);
  }
};

/**
 * Forget every submission counter.
 *
 * Exported for tests, and for nothing else: a caller that could reset the budget
 * could also spend without limit, which is why this is a plain function in the
 * server module rather than an endpoint.
 */
export const resetSubmissionCounters = (): void => {
  submissions.clear();
};

/**
 * May this request submit records at all?
 *
 * Deployed environments require a session. The live profile has no other bound on
 * who can spend its log budget, and an open write path onto the platform's own log
 * index is a thing to publish deliberately rather than by omission. Local
 * development still accepts an anonymous submission, because that is how a browser
 * console is diagnosed without inventing an account — and the local profile is
 * bounded by the same two ceilings.
 */
export const ingestionAdmission = (
  context: RequestContext,
): { ok: true } | { ok: false; detail: string } =>
  context.container.isLocal || context.user !== null
    ? { ok: true }
    : {
        ok: false,
        detail:
          'Client log ingestion requires a signed-in session outside local development. ' +
          'Sign in, or run this against a local environment where anonymous diagnostics are allowed.',
      };

/**
 * The stored shape of one submitted record.
 *
 * `release` and `source` are the *client's*, validated against the schema and kept
 * — which build produced this event is exactly the question an operator asks first.
 * The environment is overwritten from the validated container, because a client
 * that could label its records `production` would be able to hide a staging
 * incident behind a filter.
 */
const storedFor = (record: IngestRecord, context: RequestContext): LogEvent => {
  const { clientReported, userId, traceId, ...event } = record;

  // Everything the client asserted about itself, under one labelled key. The
  // submitted top-level `userId` and `traceId` are claims too, so they land here
  // rather than being dropped: "a browser claimed another identity" is a fact worth
  // having, and it is only safe to have it labelled.
  //
  // The record's own trace id is preferred over the header's, because it correlates
  // with the browser's other records. Neither becomes this record's `traceId` — the
  // server's own does, or nothing does.
  const claimedTraceId = traceId ?? context.clientTraceId ?? undefined;
  const claims: ClientReportedContext & { traceId?: string } = {
    ...clientReported,
    ...(userId === undefined ? {} : { userId }),
    ...(claimedTraceId === undefined ? {} : { traceId: claimedTraceId }),
  };

  return {
    ...event,
    app: context.emitter.context.app,
    environment: context.emitter.context.environment,
    source: event.source,
    level: event.level,
    traceId: context.traceId,
    ...(context.requestId === null ? {} : { requestId: context.requestId }),
    ...(context.user === null ? {} : { userId: context.user.id }),
    data: redactValue({
      ...event.data,
      clientReported: claims,
      ingest: {
        server: true,
        release: context.emitter.context.release,
        environment: context.emitter.context.environment,
      },
    }) as Record<string, unknown>,
  };
};

/**
 * Store one parsed record.
 *
 * Split from the route so it can be unit-tested with no HTTP involved, and written
 * through `context.emitter` so a forwarded record reaches the same single
 * destination as a server-originated one — with its own source and release intact,
 * which writing through a worker-context logger lost.
 */
export const storeRecord = (record: IngestRecord, context: RequestContext): void => {
  context.emitter.recordEvent(storedFor(record, context));
};

/** Exported for the route's response body: the number of records it accepted. */
export const countRecords = (value: IngestRecord | IngestRecord[]): number =>
  Array.isArray(value) ? value.length : 1;
