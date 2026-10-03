// apps/frontend/native/src/lib/platform/bearer_transport.test.ts
//
// What the native host actually puts on the wire.

import { describe, expect, test } from 'bun:test';
import { createBearerTransport } from './bearer_transport.ts';

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

const capture = (responses: Response[]): { fetch: typeof globalThis.fetch; seen: Seen[] } => {
  const seen: Seen[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next ?? new Response('{}', { status: 200 });
  }) as typeof globalThis.fetch;

  return { fetch: fetchImpl, seen };
};

const ok = (body: unknown = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('the bearer transport', () => {
  test('addresses an absolute origin, not the shell', async () => {
    // A relative URL here would resolve against the custom protocol the shell
    // serves files from, and the answer would be HTML.
    const { fetch, seen } = capture([ok()]);
    const transport = createBearerTransport({
      origin: 'https://api.example.test',
      getToken: () => 'token-value',
      fetch,
    });

    await transport.request('/api/notes');

    expect(seen[0]?.url).toBe('https://api.example.test/api/notes');
  });

  test('sends the token as a bearer header and never as a cookie', async () => {
    const { fetch, seen } = capture([ok()]);
    const transport = createBearerTransport({
      origin: 'https://api.example.test',
      getToken: () => 'token-value',
      fetch,
    });

    await transport.request('/api/notes');

    const headers = new Headers(seen[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer token-value');
    // `omit` rather than `include`: there is no cookie jar, and including one
    // would attach whatever the webview holds for a third-party origin.
    expect(seen[0]?.init?.credentials).toBe('omit');
    expect(headers.get('cookie')).toBeNull();
  });

  test('reads the token per request, so a sign-out is a sign-out', async () => {
    const { fetch, seen } = capture([ok(), ok()]);
    let token: string | null = 'token-value';
    const transport = createBearerTransport({
      origin: 'https://api.example.test',
      getToken: () => token,
      fetch,
    });

    await transport.request('/api/notes');
    token = null; // sign out
    await transport.request('/api/notes');

    expect(new Headers(seen[0]?.init?.headers).get('authorization')).toBe('Bearer token-value');
    // Not an error: an unauthenticated call is what a signed-out client makes,
    // and the API's 401 is the answer the sign-in screen renders.
    expect(new Headers(seen[1]?.init?.headers).get('authorization')).toBeNull();
  });

  test('passes a body, an abort signal and a trace through', async () => {
    const { fetch, seen } = capture([ok()]);
    const controller = new AbortController();
    const transport = createBearerTransport({
      origin: 'https://api.example.test',
      getToken: () => 'token-value',
      fetch,
    });

    await transport.request('/api/notes', {
      method: 'POST',
      body: { title: 'a note' },
      signal: controller.signal,
      traceId: 'tr-1',
    });

    const init = seen[0]?.init ?? {};
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ title: 'a note' }));
    expect(init.signal).toBe(controller.signal);
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-trace-id')).toBe('tr-1');
  });

  test('a caller cannot replace the authorization header', async () => {
    // Belt and braces rather than a real flow: no caller in this repository
    // sends `authorization`, and a future one that does must not be able to
    // present a token other than the session's.
    const { fetch, seen } = capture([ok()]);
    const transport = createBearerTransport({
      origin: 'https://api.example.test',
      getToken: () => 'session-token',
      fetch,
    });

    await transport.request('/api/notes', { headers: { authorization: 'Bearer somebody-elses' } });

    expect(new Headers(seen[0]?.init?.headers).get('authorization')).toBe('Bearer session-token');
  });

  test('turns a 401 into a typed failure rather than an empty success', async () => {
    const { fetch } = capture([new Response('{"message":"no"}', { status: 401 })]);
    const transport = createBearerTransport({
      origin: 'https://api.example.test',
      getToken: () => null,
      fetch,
    });

    await expect(transport.request('/api/notes')).rejects.toThrow();
  });
});
