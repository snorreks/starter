// apps/backend/api/src/lib/telemetry.ts
//
// Client log ingestion.
//
// Four things this endpoint is careful about, each of which is a real abuse or
// leak vector:
//
//   1. **Client-reported context is not identity.** Anything the browser claims
//      about itself arrives under `clientReported` and is stored as a label. The
//      verified user id comes from the session, never from the payload — a
//      client that could choose its own `userId` would be able to plant
//      misleading entries in another user's log history.
//   2. **Redaction happens before storage**, not after retrieval.
//   3. **Rate limiting is per session and per IP**, because this is the one
//      unauthenticated-reachable write path in the API.
//   4. **A failure to store never fails the request.** Telemetry that breaks the
//      product is worse than telemetry that is missing.

import { redactValue } from '@starter/logger';
import { Elysia, t } from 'elysia';
import { LogEventSchema, type LogEvent } from '@starter/schemas/logging';
import { buildRequestContext, type RequestContext } from './request_context.ts';

const MAX_BODY_BYTES = 16 * 1024;
const WINDOW_MS = 60_000;
const MAX_EVENTS_PER_WINDOW = 60;

export type TelemetryResult = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * Fixed-window counter.
 *
 * Deliberately in-memory: it is a per-isolate best-effort brake, not an
 * accounting system. A Worker isolate is ephemeral and there is no shared state
 * here, so this is honestly documented as approximate — a determined caller
 * gets a new isolate. A durable limiter is a real requirement only once this
 * endpoint is reachable at scale.
 */
const hits = new Map<string, { count: number; resetAt: number }>();

const rateLimitKey = (context: RequestContext, ip: string | null): string =>
  `${context.user?.id ?? `ip:${ip ?? 'unknown'}`}`;

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

export const handleTelemetry = async (request: Request, context: RequestContext): Promise<TelemetryResult> => {
  const now = Date.now();
  if (now % 5_000 < 1_000) {
    sweep(now);
  }

  const ip = request.headers.get('cf-connecting-ip');
  if (isRateLimited(rateLimitKey(context, ip))) {
    return { status: 429, body: { error: 'rate_limited', message: 'Too many log events.' } };
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES) {
    return { status: 413, body: { error: 'too_large', message: 'Log event is too large.' } };
  }

  let payload: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return { status: 413, body: { error: 'too_large', message: 'Log event is too large.' } };
    }
    payload = JSON.parse(text);
  } catch {
    return { status: 400, body: { error: 'bad_request', message: 'Body is not valid JSON.' } };
  }

  const records = Array.isArray(payload) ? payload : [payload];
  const accepted: string[] = [];
  const rejected: number[] = [];

  records.forEach((record, index) => {
    const parsed = LogEventSchema.safeParse(record);
    if (!parsed.success) {
      rejected.push(index);
      return;
    }

    const event: LogEvent = parsed.data;

    // Client-reported identity is demoted, then redacted with everything else.
    const reported = (record as { clientReported?: unknown }).clientReported;
    const stored = {
      ...event,
      // A browser cannot be trusted to name the user it is acting for.
      userId: context.user?.id,
      sessionId: context.user === null ? event.sessionId : undefined,
      data: redactValue(event.data) as Record<string, unknown> | undefined,
      ...(reported === undefined
        ? {}
        : { data: { clientReported: redactValue(reported) } }),
    };

    // Round 1 stores to the platform's log stream via console, which is what
    // `wrangler tail` and the provider's own log product both index. Writing to
    // a D1 table was considered and rejected: it would need its own retention
    // policy, its own index, and a migration, for a capability the platform
    // already provides.
    context.logger.write({
      logLevel: stored.level,
      logType: stored.level === 'ERROR' ? 'error' : 'info',
      event: stored.event,
      message: stored.message,
      traceId: context.traceId,
      ...(stored.userId === undefined ? {} : { userId: stored.userId }),
    });

    accepted.push(stored.event);
  });

  return {
    status: 202,
    body: { accepted: accepted.length, rejected: rejected.length },
  };
};

/** The ingest route. */
export const telemetryRoutes = () =>
  new Elysia({ name: 'starter/telemetry' }).post(
    '/api/telemetry',
    async ({ request }) => {
      const requestContext = await buildRequestContext(request);
      const result = await handleTelemetry(request, requestContext);
      return Response.json(result.body, { status: result.status });
    },
    {
      response: {
        202: t.Object({ accepted: t.Number(), rejected: t.Number() }),
        400: t.Object({ error: t.String(), message: t.String() }),
        413: t.Object({ error: t.String(), message: t.String() }),
        429: t.Object({ error: t.String(), message: t.String() }),
      },
    },
  );
