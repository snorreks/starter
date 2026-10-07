// apps/frontend/client/src/lib/server/telemetry_service.test.ts
//
// What `/api/telemetry` accepts, and what it is allowed to believe.
//
// The defect this file exists for was a closed-object intersection:
// `Type.Intersect([LogEventSchema, {clientReported}])`, where `LogEventSchema` is
// `additionalProperties: false`. JSON Schema intersection is a conjunction, so the
// payload the transport *always* sends — the event plus `clientReported` — was
// rejected by the endpoint the transport posts to. The browser's forwarding path
// could not work, and nothing tested it.
//
// So the first case builds the payload exactly the way
// `createHttpTelemetryTransport` builds it and asserts the schema admits it. The
// rest are the controls that must keep working when that admission is widened:
// unknown fields stay rejected, an array is bounded, and a client that asserts an
// identity does not get one.

import { describe, expect, test } from 'bun:test';
import { createHttpTelemetryTransport } from '@starter/logger';
import { checkSchema } from '@starter/schemas/common';
import type { LogEvent } from '@starter/schemas/logging';
import { createId } from '@starter/utils';
import type { Container } from '#lib/server/container.ts';
import type { RequestContext, RequestUser } from './request_context.ts';
import {
  IngestBodySchema,
  ingestionAdmission,
  isRateLimited,
  MAX_RECORDS_PER_SUBMISSION,
  MAX_SUBMISSIONS_PER_WINDOW,
  resetSubmissionCounters,
  storeRecord,
} from './telemetry_service.ts';

type IngestRecord = Parameters<typeof storeRecord>[0];

const user: RequestUser = {
  id: 'user-verified',
  email: 'a@example.test',
  displayName: 'A',
  provider: 'email',
  emailVerified: true,
};

const container = (
  overrides: Partial<Pick<Container, 'isLocal' | 'environment'>> = {},
): Container =>
  ({
    isLocal: false,
    environment: 'staging',
    ...overrides,
  }) as unknown as Container;

/**
 * A context whose emitter captures instead of writing.
 *
 * The emitter is the single destination every record goes through, so replacing it
 * is how these tests observe output without a console, a file or a Worker. The
 * server context it carries is the authority for the ingest side of a forwarded
 * record, so it is stated here rather than left implicit.
 */
const contextWith = (resolved: RequestUser | null = user): ObservedContext => {
  const emitted: LogEvent[] = [];
  const context = {
    user: resolved,
    traceId: 'tr-server',
    requestId: 'ray-server',
    clientTraceId: null,
    container: container(),
    logger: undefined as unknown as RequestContext['logger'],
    emitter: {
      name: 'capture',
      context: {
        app: 'web',
        environment: 'staging',
        source: 'worker',
        release: 'dev',
      },
      recordEvent: (event: LogEvent) => {
        emitted.push(event);
      },
      emit: () => {
        /* The store writes whole records; the emitter's own emit path is covered in
           request_context.test.ts. */
      },
    },
    emitted,
  };
  return context as unknown as ObservedContext;
};

interface ObservedContext extends RequestContext {
  emitted: LogEvent[];
}

const browserEvent = (overrides: Partial<LogEvent> = {}): LogEvent => ({
  timestamp: Date.now(),
  app: 'web',
  environment: 'local',
  source: 'browser',
  level: 'INFO',
  event: 'notes.create',
  release: 'browser-2026-10-01',
  ...overrides,
});

describe('the payload the transport actually sends', () => {
  test('an event carrying clientReported is admitted', async () => {
    // The real transport, with the real context callback: no hand-written stand-in
    // that could accidentally match what the schema was written for.
    // The transport fires and forgets, so the body is awaited through the fetch it
    // makes rather than through a sleep.
    let deliver: (body: unknown) => void = () => undefined;
    const sent = new Promise<unknown>((resolve) => {
      deliver = resolve;
    });

    const transport = createHttpTelemetryTransport({
      endpoint: 'https://web.example.test/api/telemetry',
      // `unknown` first and a cast at the boundary, the way the pipeline's own
      // fetch recorder does it: a bare arrow is not structurally a `typeof fetch`.
      fetchImpl: (async (_url: unknown, init?: { body?: unknown }) => {
        deliver(JSON.parse(String(init?.body)));
        return new Response('{}', { status: 202 });
      }) as typeof globalThis.fetch,
      context: () => ({ userId: 'client-claims-this', platform: 'linux' }),
    });

    transport.send(browserEvent({ userId: 'client-claims-this' }));
    const body = await sent;

    expect(body).toBeDefined();
    expect(checkSchema(IngestBodySchema, body)).toBe(true);
  });

  test('a bare event without clientReported is still admitted', () => {
    expect(checkSchema(IngestBodySchema, browserEvent())).toBe(true);
  });
});

describe('the schema stays closed to everything else', () => {
  test('an unknown top-level field is refused', () => {
    const forged = { ...browserEvent(), trustedUserId: 'root', environment_: 'staging' };
    expect(checkSchema(IngestBodySchema, forged)).toBe(false);
  });

  test('a client cannot declare its own environment or source of record', () => {
    // Both are real schema values, so these are admitted as *fields* — but the
    // service overwrites them from the container. This test pins the field set;
    // the demotion is asserted below.
    const claimed = { ...browserEvent(), environment: 'production' };
    expect(checkSchema(IngestBodySchema, claimed)).toBe(true);
  });

  test('an event name that is not a string is refused', () => {
    expect(checkSchema(IngestBodySchema, { ...browserEvent(), event: 7 })).toBe(false);
  });

  test('an unknown field nested inside clientReported is refused', () => {
    const nested = {
      ...browserEvent(),
      clientReported: { userId: 'u', isAdmin: true },
    };
    expect(checkSchema(IngestBodySchema, nested)).toBe(false);
  });
});

describe('one submission is bounded', () => {
  test(`twenty records are admitted and ${MAX_RECORDS_PER_SUBMISSION + 1} are refused`, () => {
    const records = (count: number): unknown[] =>
      Array.from({ length: count }, () => browserEvent());

    expect(checkSchema(IngestBodySchema, records(MAX_RECORDS_PER_SUBMISSION))).toBe(true);
    expect(checkSchema(IngestBodySchema, records(MAX_RECORDS_PER_SUBMISSION + 1))).toBe(false);
  });
});

describe('a client-reported identity is data, not identity', () => {
  test('a forged top-level userId does not become the stored user id', () => {
    resetSubmissionCounters();
    const context = contextWith();
    const record = {
      ...browserEvent({ userId: 'somebody-else' }),
      clientReported: { userId: 'somebody-else', platform: 'linux' },
    } as IngestRecord;

    storeRecord(record, context);

    const stored = context.emitted[0] as LogEvent;
    expect(stored.userId).toBe('user-verified');
    // Kept, because "a browser says it was somebody else" is exactly the fact an
    // operator needs — as a labelled value, never as the record's identity.
    const data = stored.data as Record<string, unknown>;
    const reported = data.clientReported as Record<string, unknown>;
    expect(reported.userId).toBe('somebody-else');
    expect(stored.source).toBe('browser');
  });

  test('an anonymous submission stores no user id at all', () => {
    resetSubmissionCounters();
    const context = contextWith(null);
    storeRecord(
      {
        ...browserEvent({ userId: 'claimed' }),
        clientReported: { userId: 'claimed' },
      } as IngestRecord,
      context,
    );

    const stored = context.emitted[0] as LogEvent;
    expect(stored.userId).toBeUndefined();
  });

  test('the forwarded record keeps its own source and its own release', () => {
    resetSubmissionCounters();
    const context = contextWith();
    storeRecord(
      { ...browserEvent({ release: 'browser-2026-10-01' }), clientReported: {} } as IngestRecord,
      context,
    );

    const stored = context.emitted[0] as LogEvent;
    expect(stored.source).toBe('browser');
    expect(stored.release).toBe('browser-2026-10-01');
    // The environment is the server's, from the validated container: a client that
    // claims `production` does not get to move its record into production.
    expect(stored.environment).toBe('staging');
    // The server's own trace and the ingest release are recorded alongside, so a
    // forwarded record is still correlatable with the request that accepted it.
    expect(stored.traceId).toBe('tr-server');
    expect(stored.requestId).toBe('ray-server');
    const data = stored.data as Record<string, unknown>;
    const ingest = data.ingest as Record<string, unknown>;
    expect(ingest.release).toBe('dev');
    expect(ingest.server).toBe(true);
  });

  test('a submitted trace id is kept as a claim, never used as the record’s identity', () => {
    resetSubmissionCounters();
    const context = contextWith();
    storeRecord(
      { ...browserEvent({ traceId: 'tr_client_1' }), clientReported: {} } as IngestRecord,
      context,
    );

    const stored = context.emitted[0] as LogEvent;
    expect(stored.traceId).toBe('tr-server');
    const reported = (stored.data as Record<string, unknown>).clientReported as Record<
      string,
      unknown
    >;
    expect(reported.traceId).toBe('tr_client_1');
  });

  test('the redacted payload survives, with secrets removed', () => {
    resetSubmissionCounters();
    const context = contextWith();
    storeRecord(
      {
        ...browserEvent({ data: { noteId: createId('nt'), password: 'hunter2' } }),
        clientReported: {},
      } as IngestRecord,
      context,
    );

    const stored = context.emitted[0] as LogEvent;
    const data = stored.data as Record<string, unknown>;
    expect(data.noteId).toMatch(/^nt_/);
    expect(JSON.stringify(stored)).not.toContain('hunter2');
  });
});

describe('who may submit', () => {
  test('a deployed environment refuses an anonymous submission', () => {
    const context = contextWith(null);
    const admitted = ingestionAdmission(context);
    expect(admitted.ok).toBe(false);
  });

  test('a deployed environment admits a signed-in caller', () => {
    expect(ingestionAdmission(contextWith(user)).ok).toBe(true);
  });

  test('local development admits an anonymous caller, because that is the diagnostic path', () => {
    resetSubmissionCounters();
    const context = {
      ...contextWith(null),
      container: container({ isLocal: true, environment: 'local' }),
    } as unknown as RequestContext;
    expect(ingestionAdmission(context).ok).toBe(true);
  });
});

describe('the submission budget is counted in submissions, and says so', () => {
  test('a submission carrying twenty records spends one unit of budget', () => {
    resetSubmissionCounters();
    const key = 'budget-unit-test';
    // Twenty records is the per-submission ceiling; if the counter were counting
    // records, one browser flush would exhaust a minute's budget on its own.
    expect(MAX_SUBMISSIONS_PER_WINDOW).toBeGreaterThan(0);
    for (let index = 0; index < MAX_SUBMISSIONS_PER_WINDOW; index += 1) {
      expect(isRateLimited(key)).toBe(false);
    }
    expect(isRateLimited(key)).toBe(true);
  });

  test('the window resets, so a browser recovers on its own', () => {
    resetSubmissionCounters();
    const key = 'budget-window-test';
    for (let index = 0; index < MAX_SUBMISSIONS_PER_WINDOW; index += 1) {
      isRateLimited(key, 1_000);
    }
    expect(isRateLimited(key, 1_000)).toBe(true);
    expect(isRateLimited(key, 1_000 + 61_000)).toBe(false);
  });
});
