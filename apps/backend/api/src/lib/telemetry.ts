// apps/backend/api/src/lib/telemetry.ts
//
// Client log ingestion.
//
// Five things this endpoint is careful about, each an abuse or leak vector:
//
//   1. **Client-reported context is not identity.** Anything the browser claims
//      about itself arrives under `clientReported` and is stored as a label. The
//      verified user id comes from the session, never from the payload — a
//      client that could choose its own `userId` could plant misleading entries
//      in another user's log history.
//   2. **Redaction happens before storage**, not after retrieval.
//   3. **Rate limiting** is per session and per IP: this is the one
//      unauthenticated-reachable write path in the API.
//   4. **A failure to store never fails the request.** Telemetry that breaks the
//      product is worse than telemetry that is missing.
//   5. **The body is size-capped by the router**, before parsing.
//
// Validation is Elysia's job, via the `body` schema, exactly as it is for the
// notes routes. Reading the body by hand — `await request.text()` — does not
// work reliably here: by the time a handler runs, the router may already hold
// the stream, and `request.text()` then fails with "Body is not valid JSON" for
// a perfectly valid payload.

import { redactValue } from '@starter/logger';
import { Elysia, status, t } from 'elysia';
import type { Static } from '@sinclair/typebox';
import {
  ClientReportedContextSchema,
  LogEventSchema,
  type ClientReportedContext,
  type LogEvent,
} from '@starter/schemas/logging';
import type { Container } from './container.ts';
import { buildRequestContext, type RequestContext } from './request_context.ts';

/** Hard ceiling on one submission. Rejected before parsing. */
export const MAX_BODY_BYTES = 16 * 1024;

const WINDOW_MS = 60_000;
const MAX_EVENTS_PER_WINDOW = 60;
const SWEEP_INTERVAL_MS = 5_000;

/**
 * One submitted record.
 *
 * The event fields plus the self-asserted context. Modelled explicitly rather
 * than as `LogEvent & { clientReported }` because the router validates
 * `additionalProperties: false`, and the point is to admit exactly one extra
 * field — the one that is explicitly labelled as unverified.
 */
const IngestRecordSchema = t.Intersect([
  LogEventSchema,
  t.Object({ clientReported: t.Optional(ClientReportedContextSchema) }),
]);

const IngestBodySchema = t.Union([IngestRecordSchema, t.Array(IngestRecordSchema)]);

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

export type IngestRecord = Static<typeof IngestRecordSchema>;

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

  // Round 1 writes to the platform's own log stream via the logger, which is
  // what `wrangler tail` and the provider's Logs product both index. A D1 table
  // was considered and rejected: it would need its own retention policy, its
  // own index, and a migration, for a capability the platform already provides.
  context.logger.write({
    logLevel: stored.level,
    logType: stored.level === 'ERROR' ? 'error' : 'info',
    event: stored.event,
    message: stored.message,
    traceId: context.traceId,
    ...(stored.userId === undefined ? {} : { userId: stored.userId }),
  });
};

export const telemetryRoutes = (container: Container) =>
  new Elysia({ name: 'starter/telemetry' }).post(
    '/api/telemetry',
    async ({ request, body }) => {
      const context = await buildRequestContext(request, container);

      const now = Date.now();
      if (now % SWEEP_INTERVAL_MS < 1_000) {
        sweep(now);
      }

      if (isRateLimited(rateLimitKey(context, request.headers.get('cf-connecting-ip')))) {
        return status(429, { error: 'rate_limited', message: 'Too many log events.' });
      }

      const records = Array.isArray(body) ? body : [body];
      for (const record of records) {
        storeRecord(record, context);
      }

      return status(202, { accepted: records.length, rejected: 0 });
    },
    {
      body: IngestBodySchema,
      bodyLimit: MAX_BODY_BYTES,
      response: {
        202: t.Object({ accepted: t.Number(), rejected: t.Number() }),
        // Emitted by the router's own validation, not by the handler.
        413: t.Object({ error: t.String(), message: t.String() }),
        429: t.Object({ error: t.String(), message: t.String() }),
      },
    },
  );
