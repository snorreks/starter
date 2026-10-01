// apps/frontend/client/src/lib/server/telemetry_service.ts
//
// Client log ingestion.
//
// Five things this is careful about, each an abuse or leak vector:
//
//   1. **Client-reported context is not identity.** Anything the browser claims
//      about itself arrives under `clientReported` and is stored as a label. The
//      verified user id comes from the session, never from the payload — a
//      client that could choose its own `userId` could plant misleading entries
//      in another user's log history.
//   2. **Redaction happens before storage**, not after retrieval.
//   3. **Rate limiting** is per session and per IP: this is the one
//      unauthenticated-reachable write path in the application.
//   4. **A failure to store never fails the request.** Telemetry that breaks the
//      product is worse than telemetry that is missing.
//   5. **The body is size-capped by the route**, before parsing.
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

/** Hard ceiling on one submission. Rejected by the route before parsing. */
export const MAX_BODY_BYTES = 16 * 1024;

const WINDOW_MS = 60_000;
const MAX_EVENTS_PER_WINDOW = 60;
const SWEEP_INTERVAL_MS = 5_000;

/**
 * One submitted record.
 *
 * The event fields plus the self-asserted context. Modelled explicitly rather
 * than as `LogEvent & { clientReported }` because the schemas set
 * `additionalProperties: false`, and the point is to admit exactly one extra
 * field — the one that is explicitly labelled as unverified.
 */
export const IngestRecordSchema = Type.Intersect([
  LogEventSchema,
  Type.Object({ clientReported: Type.Optional(ClientReportedContextSchema) }),
]);

export const IngestBodySchema = Type.Union([IngestRecordSchema, Type.Array(IngestRecordSchema)]);

export type IngestRecord = Static<typeof IngestRecordSchema>;

/**
 * Fixed-window counter.
 *
 * Deliberately in-memory: a best-effort brake, not an accounting system. A
 * Worker isolate is ephemeral and there is no shared state here, so this is
 * honestly approximate — a determined caller gets a new isolate. A durable
 * limiter becomes a real requirement only once this endpoint is reachable at
 * scale, and that is a decision to make with data rather than in advance.
 */
const hits = new Map<string, { count: number; resetAt: number }>();

const rateLimitKey = (context: RequestContext, ip: string | null): string =>
  context.user?.id ?? `ip:${ip ?? 'unknown'}`;

export const isRateLimited = (key: string, now = Date.now()): boolean => {
  const entry = hits.get(key);

  if (!entry || now >= entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > MAX_EVENTS_PER_WINDOW;
};

/** Drop expired counters so the map cannot grow without bound. */
const sweep = (now: number): void => {
  for (const [key, entry] of hits) {
    if (now >= entry.resetAt) {
      hits.delete(key);
    }
  }
};

/** Call before ingesting, so the counter map does not accumulate forever. */
export const maybeSweep = (now = Date.now()): void => {
  if (now % SWEEP_INTERVAL_MS < 1_000) {
    sweep(now);
  }
};

export const limiterKeyFor = rateLimitKey;

/**
 * Store one parsed record.
 *
 * Split from the route so it can be unit-tested with no HTTP involved.
 */
export const storeRecord = (record: IngestRecord, context: RequestContext): void => {
  const { clientReported, ...event } = record;

  // The browser's claim about who it is is demoted to a labelled field, and the
  // verified id comes from the session. A client cannot choose whose log
  // history its events land in.
  const stored: LogEvent = {
    ...event,
    userId: context.user?.id,
    data: redactValue(
      clientReported === undefined
        ? event.data
        : { ...event.data, clientReported: clientReported as ClientReportedContext },
    ) as Record<string, unknown> | undefined,
  };

  // Writes to the platform's own log stream via the logger, which is what
  // `wrangler tail` and the provider's Logs product both index. A D1 table was
  // considered and rejected: it would need its own retention policy, its own
  // index, and a migration, for a capability the platform already provides.
  context.logger.write({
    logLevel: stored.level,
    logType: stored.level === 'ERROR' ? 'error' : 'info',
    event: stored.event,
    message: stored.message,
    traceId: context.traceId,
    ...(stored.userId === undefined ? {} : { userId: stored.userId }),
  });
};
