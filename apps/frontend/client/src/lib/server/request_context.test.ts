// apps/frontend/client/src/lib/server/request_context.test.ts
//
// The per-request context: where a record actually goes, and what it is allowed
// to claim.
//
// F1 was a *silent* defect, and silence is exactly what a test that only inspects
// return values cannot see. `buildRequestContext` used to build a logger with
// `silent: true` in workerd and register no sink, so in a deployed Worker every
// record was dropped before it reached the platform console — and the function
// still returned a perfectly well-typed logger. These tests therefore observe the
// *output*, not the return value: the platform console in workerd, stdout in Node.
//
// The runtime is passed explicitly rather than detected here on purpose. Detection
// reads `globalThis.process`, so a unit test could only exercise the branch its own
// process happens to be; that would make the workerd assertion untestable and the
// Node assertion true only on Node. `tests/worker_integration.test.ts` covers the
// real detection against the built Worker in workerd.

import { afterEach, describe, expect, test } from 'bun:test';
import type { VerifiedIdentity } from '@starter/auth/supabase';
import type { LogEvent } from '@starter/schemas/logging';
import type { Container } from '#lib/server/container.ts';
import type { RequestContext, RequestUser } from './request_context.ts';
import { buildRequestContext } from './request_context.ts';

/** Captures everything written to `console.*`, restoring it afterwards. */
const captureConsole = (): { calls: [string, unknown[]][]; restore: () => void } => {
  const calls: [string, unknown[]][] = [];
  const methods = ['info', 'warn', 'error', 'debug', 'log'] as const;
  const original = Object.fromEntries(
    methods.map((method) => [method, console[method]] as const),
  ) as Record<(typeof methods)[number], typeof console.info>;

  for (const method of methods) {
    console[method] = ((...args: unknown[]) => {
      calls.push([method, args]);
    }) as typeof console.info;
  }

  return {
    calls,
    restore: () => {
      for (const method of methods) {
        console[method] = original[method];
      }
    },
  };
};

/** Captures stdout writes, restoring the real one afterwards. */
const captureStdout = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // Typed as the widest overload: the sink only ever calls it with a string.
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;

  return {
    lines,
    restore: () => {
      process.stdout.write = original;
    },
  };
};

afterEach(() => {
  // Nothing to restore globally: each capture restores itself in its own test.
});

const user: RequestUser = {
  id: 'f45b2c4a-7919-4f55-ae89-e73f6753e322',
  email: 'a@example.test',
  displayName: 'A',
  provider: 'email',
  emailVerified: true,
};

/**
 * A container with a session resolver and nothing else.
 *
 * Logger tests only need the configured environment and release metadata. Identity
 * is supplied through the same verified Supabase boundary as production.
 */
const containerWith = (
  overrides: Partial<Pick<Container, 'environment' | 'isLocal'>> = {},
): Container =>
  ({
    environment: 'staging',
    isLocal: false,
    env: { RELEASE: 'abc1234' },
    baseUrl: 'https://starter-staging.example',
    ...overrides,
  }) as unknown as Container;

const request = (headers: Record<string, string> = {}): Request =>
  new Request('https://starter-staging.example/api/notes', { headers });

const structured = (calls: [string, unknown[]][]): LogEvent[] =>
  calls.map(([, args]) => JSON.parse(String(args[0])) as LogEvent);

const identity = (requestUser: RequestUser): VerifiedIdentity => ({
  backend: 'supabase',
  user: requestUser,
  accessToken: 'fixture-access-token',
});

describe('one record, one destination', () => {
  test('a workerd request record reaches the platform console, exactly once', async () => {
    const console = captureConsole();
    try {
      const context = await buildRequestContext(containerWith(), request(), {
        runtime: 'workerd',
        identity: identity(user),
      });
      context.logger.write({ logLevel: 'INFO', logType: 'info', event: 'notes.create' });

      // The whole defect: before the fix this was zero, because `silent` suppressed
      // the console and no sink was registered for the platform to capture.
      expect(console.calls).toHaveLength(1);
      const [event] = structured(console.calls);
      expect(event?.app).toBe('web');
      expect(event?.event).toBe('notes.create');
      expect(event?.release).toBe('abc1234');
      expect(event?.traceId).toBe(context.traceId);
    } finally {
      console.restore();
    }
  });

  test('the workerd record is one JSON object, not a human-formatted line', async () => {
    const console = captureConsole();
    try {
      const context = await buildRequestContext(containerWith(), request(), {
        runtime: 'workerd',
        identity: identity(user),
      });
      context.logger.write({
        logLevel: 'ERROR',
        logType: 'error',
        event: 'notes.update',
        message: 'boom',
      });

      expect(console.calls).toHaveLength(1);
      // Level must reach the right console method: Cloudflare indexes by it, and a
      // record that always arrives as `info` makes an error page unfindable.
      expect(console.calls[0]?.[0]).toBe('error');
      const [event] = structured(console.calls);
      expect(event?.level).toBe('ERROR');
      expect(event?.message).toBe('boom');
    } finally {
      console.restore();
    }
  });

  test('a local Node request writes exactly one NDJSON line and no console output', async () => {
    const console = captureConsole();
    const stdout = captureStdout();
    try {
      const context = await buildRequestContext(
        containerWith({ environment: 'local', isLocal: true }),
        request(),
        { runtime: 'node', identity: identity(user) },
      );
      context.logger.write({ logLevel: 'INFO', logType: 'info', event: 'notes.create' });

      // `bun run logs web --mode local` reads stdout. A human console line here
      // would be a second record in the same stream with a different shape.
      expect(console.calls).toHaveLength(0);
      expect(stdout.lines).toHaveLength(1);

      const event = JSON.parse(stdout.lines[0] ?? '') as LogEvent;
      expect(event.event).toBe('notes.create');
      expect(event.environment).toBe('local');
    } finally {
      console.restore();
      stdout.restore();
    }
  });

  test('payload values are redacted before they leave the process', async () => {
    const console = captureConsole();
    try {
      const context = await buildRequestContext(containerWith(), request(), {
        runtime: 'workerd',
        identity: identity(user),
      });
      context.logger.write(
        { logLevel: 'INFO', logType: 'info', event: 'auth.signin' },
        { email: 'a@example.test', password: 'hunter2' },
      );

      expect(console.calls).toHaveLength(1);
      const raw = String(console.calls[0]?.[1]?.[0]);
      expect(raw).not.toContain('hunter2');
      expect(raw).toContain('[redacted]');
    } finally {
      console.restore();
    }
  });
});

describe('the environment is the one the container resolved', () => {
  test('staging stays staging instead of being reported as production', async () => {
    const console = captureConsole();
    try {
      const context = await buildRequestContext(containerWith(), request(), {
        runtime: 'workerd',
        identity: identity(user),
      });
      context.logger.write({ logLevel: 'INFO', logType: 'info', event: 'notes.create' });

      const [event] = structured(console.calls);
      // `container.isLocal ? 'local' : 'production'` labelled every deployed
      // environment `production`, so a staging incident could not be found by
      // filtering on the field that is supposed to name it.
      expect(event?.environment).toBe('staging');
    } finally {
      console.restore();
    }
  });
});

describe('server request identity is not the client’s claim', () => {
  test('the server trace id is generated here, whatever the request says', async () => {
    const console = captureConsole();
    try {
      const context = await buildRequestContext(
        containerWith(),
        request({ 'x-trace-id': 'client-supplied-trace' }),
        { runtime: 'workerd' },
      );

      expect(context.traceId).not.toBe('client-supplied-trace');
      expect(context.traceId.length).toBeGreaterThan(0);
      // Kept, but as a labelled value: a correlation label the client chose is
      // still useful for a support conversation, and useless as identity.
      expect(context.clientTraceId).toBe('client-supplied-trace');
    } finally {
      console.restore();
    }
  });

  test('an unbounded incoming correlation label is dropped rather than trusted', async () => {
    const context = await buildRequestContext(
      containerWith(),
      request({ 'x-trace-id': 'x'.repeat(5_000), 'cf-ray': 'r'.repeat(5_000) }),
      { runtime: 'workerd' },
    );

    expect(context.clientTraceId).toBeNull();
    expect(context.requestId).toBeNull();
  });

  test('an incoming label with control characters is dropped', async () => {
    const context = await buildRequestContext(
      containerWith(),
      request({ 'x-trace-id': `ok${String.fromCharCode(27)}[31m` }),
      { runtime: 'workerd' },
    );

    expect(context.clientTraceId).toBeNull();
  });

  test('a Cloudflare ray id becomes the server request id when it is well formed', async () => {
    const context = await buildRequestContext(
      containerWith(),
      request({ 'cf-ray': '8f0c1d2e3f4a5b6c-LHR' }),
      { runtime: 'workerd' },
    );

    expect(context.requestId).toBe('8f0c1d2e3f4a5b6c-LHR');
  });
});

describe('the context belongs to one request', () => {
  test('two requests get two contexts, and neither is a singleton', async () => {
    const container = containerWith();
    const [first, second] = await Promise.all([
      buildRequestContext(container, request(), { runtime: 'workerd' }),
      buildRequestContext(container, request(), { runtime: 'workerd' }),
    ]);

    expect(first.traceId).not.toBe(second.traceId);
    expect(first.logger).not.toBe(second.logger);
    expect(first.emitter).not.toBe(second.emitter);
  });

  test('two sessions never share an identity, even concurrently', async () => {
    const other: RequestUser = {
      ...user,
      id: '2c779fc3-468a-4bd9-b9f5-6cbab4e1059d',
      email: 'b@example.test',
    };
    const [first, second] = await Promise.all([
      buildRequestContext(containerWith(), request(), {
        runtime: 'workerd',
        identity: identity(user),
      }) as Promise<RequestContext>,
      buildRequestContext(containerWith(), request(), {
        runtime: 'workerd',
        identity: identity(other),
      }) as Promise<RequestContext>,
    ]);

    expect(first.user?.id).toBe(user.id);
    expect(second.user?.id).toBe(other.id);
  });
});
