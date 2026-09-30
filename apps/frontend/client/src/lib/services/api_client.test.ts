// apps/frontend/client/src/lib/services/api_client.test.ts
//
// The HTTP seam, with no network.
//
// `ApiClient` is the one place the client knows about base URLs, credentials and
// error classification. Getting it wrong is expensive and hard to see — a wrong
// status mapping shows up as a screen saying "something went wrong" instead of
// "please sign in" — so it is worth pinning down without a server.
//
// The fake transport is injected, not installed on `globalThis`. That is the
// same seam the app uses to hand the client its configuration, and it keeps the
// test from depending on whether the global is replaceable.

import { describe, expect, test } from 'bun:test';
import { ApiClient, setApiTokenProvider, type FetchLike } from '#lib/services/api_client.ts';
import { AppError, isAbortError, type AppErrorType } from '@starter/utils';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const client = (fetchImpl: FetchLike): ApiClient =>
  new ApiClient({
    baseUrl: 'https://api.example.test',
    className: 'ApiClient',
    fetch: fetchImpl,
  });

/** Run a request and return the `AppError` it threw, or null if it did not. */
const captureError = async (run: () => Promise<unknown>): Promise<AppError | null> => {
  try {
    await run();
    return null;
  } catch (caught) {
    return caught as AppError;
  }
};

describe('ApiClient', () => {
  test('requests the resolved base URL with credentials', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;

    await client(async (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return jsonResponse({ ok: true });
    }).get('/api/health');

    expect(seenUrl).toBe('https://api.example.test/api/health');
    // The session cookie must be sent in a browser; this is what makes the
    // same-origin dev proxy behave like production.
    expect(seenInit?.credentials).toBe('include');
  });

  test('a path without a leading slash still resolves to one URL', async () => {
    let seenUrl = '';
    await client(async (input) => {
      seenUrl = String(input);
      return jsonResponse({});
    }).get('api/health');

    // Otherwise the result is `https://api.example.testapi/health`.
    expect(seenUrl).toBe('https://api.example.test/api/health');
  });

  // Observed values are collected into arrays rather than assigned to a
  // `let`: a `let` initialized to `null` is narrowed to `null` at the
  // assertion, because the writes happen inside a callback the compiler does
  // not follow.
  const authHeaderSeenBy = async (
    tokenProvider: () => string | undefined,
  ): Promise<(string | null)[]> => {
    const seen: (string | null)[] = [];
    setApiTokenProvider(tokenProvider);
    try {
      await client(async (_input, init) => {
        seen.push(new Headers(init?.headers).get('authorization'));
        return jsonResponse({});
      }).get('/api/whoami');
    } finally {
      setApiTokenProvider(() => undefined);
    }
    return seen;
  };

  test('adds a bearer token when one is available', async () => {
    const seen = await authHeaderSeenBy(() => 'tok_abc');

    // How a Tauri webview authenticates: its origin is cross-site, so the
    // session cookie is never attached.
    expect(seen).toEqual(['Bearer tok_abc']);
  });

  test('sends no authorization header when there is no token', async () => {
    const seen = await authHeaderSeenBy(() => undefined);

    expect(seen).toEqual([null]);
  });

  test('classifies a 401 as unauthorized so a screen can route to sign-in', async () => {
    const error = await captureError(() =>
      client(async () =>
        jsonResponse({ error: 'unauthorized', message: 'Sign in to continue.' }, 401),
      ).get('/api/notes'),
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error?.errorType).toBe('unauthorized');
    expect(error?.status).toBe(401);
    // The server's message is surfaced, not replaced with a generic one.
    expect(error?.message).toBe('Sign in to continue.');
  });

  test('classifies the statuses a notes screen actually branches on', async () => {
    const cases: readonly (readonly [number, AppErrorType])[] = [
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [422, 'validation'],
      [429, 'rate_limited'],
      [500, 'server'],
    ];

    for (const [status, expected] of cases) {
      const caught = await captureError(() =>
        client(async () => jsonResponse({ error: expected, message: 'no' }, status)).get(
          '/api/notes',
        ),
      );

      expect(caught?.errorType).toBe(expected);
    }
  });

  test('a failure with no message falls back rather than showing "undefined"', async () => {
    const caught = await captureError(() =>
      client(async () => new Response('', { status: 500 })).get('/api/notes'),
    );

    expect(caught?.message).toBe('The request failed.');
  });

  test('a transport failure is a network error, not a crash', async () => {
    const caught = await captureError(() =>
      client(async () => {
        throw new TypeError('Failed to fetch');
      }).get('/api/notes'),
    );

    expect(caught?.errorType).toBe('network');
    expect(caught?.message).toBe('Could not reach the server.');
  });

  test('an aborted request is distinguishable from an outage', async () => {
    // This distinction matters: reporting every cancellation as an error makes
    // the user see failures for their own typing.
    const caught = await captureError(() =>
      client(async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }).get('/api/notes'),
    );

    expect(isAbortError(caught)).toBe(true);
    expect(caught?.errorType).toBe('aborted');
  });

  test('a 204 resolves to undefined rather than failing on empty JSON', async () => {
    const result = await client(async () => new Response(null, { status: 204 })).delete(
      '/api/notes/note_1',
    );

    expect(result).toBeUndefined();
  });

  test('a non-JSON response produces a clear error, not a syntax error', async () => {
    const caught = await captureError(() =>
      client(async () => new Response('<html>gateway timeout</html>', { status: 504 })).get(
        '/api/notes',
      ),
    );

    expect(caught?.errorType).toBe('server');
    expect(caught?.message).toContain('not JSON');
  });

  test('a JSON body is sent with a content-type, and no body sends none', async () => {
    const headers: (string | null)[] = [];
    const transport: FetchLike = async (_input, init) => {
      headers.push(new Headers(init?.headers).get('content-type'));
      return jsonResponse({ ok: true });
    };

    await client(transport).post('/api/notes', { title: 'a', body: 'b' });
    await client(transport).get('/api/notes');

    expect(headers[0]).toContain('application/json');
    // A content-type on a bodyless request makes the router try to parse an
    // empty stream, which turns a DELETE into a 500.
    expect(headers[1]).toBeNull();
  });

  test('a JSON body is serialized, and a trace id is attached', async () => {
    const seen: { body?: BodyInit | null; trace: string | null } = { trace: null };

    await client(async (_input, init) => {
      seen.body = init?.body;
      seen.trace = new Headers(init?.headers).get('x-trace-id');
      return jsonResponse({});
    }).post('/api/notes', { title: 'a' }, { traceId: 'trace_1' });

    expect(seen.body).toBe('{"title":"a"}');
    // This is the link between a client log line and the Worker log line.
    expect(seen.trace).toBe('trace_1');
  });

  test('every verb reaches the transport with its method', async () => {
    const methods: (string | undefined)[] = [];
    const transport: FetchLike = async (_input, init) => {
      methods.push(init?.method);
      return jsonResponse({});
    };

    await client(transport).get('/api/notes');
    await client(transport).post('/api/notes', { title: 'a' });
    await client(transport).patch('/api/notes/note_1', { title: 'b' });
    await client(transport).delete('/api/notes/note_1');

    expect(methods).toEqual(['GET', 'POST', 'PATCH', 'DELETE']);
  });

  test('an abort signal is passed through to the transport', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | null | undefined;

    await client(async (_input, init) => {
      seenSignal = init?.signal;
      return jsonResponse({});
    }).get('/api/notes', { signal: controller.signal });

    expect(seenSignal).toBe(controller.signal);
  });
});