// packages/frontend/platform/src/api_transport.test.ts
//
// What the transport is responsible for: the uniform error shape, and the fact
// that credentials are a decision rather than a constant.
//
// The negative controls here are the point. A transport that always sends
// cookies is not wrong on the web origin and is wrong the moment a URL comes from
// something a user typed, and nothing else in the repository would notice.

import { describe, expect, test } from 'bun:test';
import { AppError, type AppErrorType, isAbortError } from '@starter/utils';
import { type FetchLike, HttpTransport } from './api_transport.ts';

interface Call {
  url: string;
  init: RequestInit;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A recording fetch against an absolute base URL. Returns the calls too. */
const recording = (
  respond: (call: Call) => Response | Promise<Response>,
): { transport: HttpTransport; calls: Call[] } => {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  };
  return {
    transport: new HttpTransport({
      fetch: fetchImpl,
      credentials: 'include',
      baseUrl: 'https://api.example.test',
    }),
    calls,
  };
};

describe('a transport classifies every failure the same way', () => {
  test('a 403 becomes a forbidden AppError carrying the server message', async () => {
    const { transport } = recording(() =>
      jsonResponse({ error: 'forbidden', message: 'That address is not confirmed.' }, 403),
    );

    const failure = await transport.request('/api/notes').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).errorType).toBe('forbidden');
    // The server's own text, so a screen can act on it. The generic 'The request
    // failed.' is the fallback for a response with no envelope.
    expect((failure as AppError).message).toBe('That address is not confirmed.');
  });

  test('a 429 is rate_limited rather than a generic server error', async () => {
    const { transport } = recording(() => jsonResponse({ message: 'Slow down.' }, 429));

    const failure = (await transport
      .request('/api/auth/sign-in/email', { method: 'POST', body: {} })
      .catch((error: unknown) => error)) as AppError;

    expect(failure.errorType).toBe('rate_limited');
  });

  test('a response that is not JSON is refused rather than returned as undefined', async () => {
    // A proxy's HTML error page. `parseBody as T` would hand a string to a caller
    // expecting notes, and the failure would appear as an empty list three layers
    // away — the bug this transport's caller now guards against with a schema.
    const { transport } = recording(
      () =>
        new Response('<html>502</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    const failure = (await transport
      .request('/api/notes')
      .catch((error: unknown) => error)) as AppError;

    expect(failure.errorType).toBe('server');
    expect(failure.message).toMatch(/not JSON/i);
  });

  test('an aborted request is not reported as an outage', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const { transport } = recording(() => Promise.reject(abort));

    const failure = (await transport
      .request('/api/notes')
      .catch((error: unknown) => error)) as AppError;

    // A cancellation shown as "Could not reach the server" is how a screen that
    // navigated away ends up displaying an error about a network it never used.
    expect(isAbortError(failure)).toBe(true);
    expect(failure.errorType).toBe('aborted');
  });

  test('classifies every status a screen branches on', async () => {
    // A wrong mapping shows up as a screen saying "something went wrong" where it
    // should say "please sign in", which is indistinguishable from a bug in the
    // screen. Pinned as a table rather than sampled.
    const cases: readonly (readonly [number, AppErrorType])[] = [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [422, 'validation'],
      [429, 'rate_limited'],
      [500, 'server'],
    ];

    for (const [status, expected] of cases) {
      const { transport } = recording(() =>
        jsonResponse({ error: expected, message: 'no' }, status),
      );
      const caught = (await transport
        .request('/api/notes')
        .catch((error: unknown) => error)) as AppError;

      expect(caught.errorType).toBe(expected);
      expect(caught.status).toBe(status);
    }
  });

  test('a failure with no message falls back rather than showing "undefined"', async () => {
    const { transport } = recording(() => new Response('', { status: 500 }));

    const caught = (await transport
      .request('/api/notes')
      .catch((error: unknown) => error)) as AppError;

    expect(caught.message).toBe('The request failed.');
  });

  test('a dead network is a network error rather than a raw TypeError', async () => {
    const { transport } = recording(() => {
      throw new TypeError('Failed to fetch');
    });

    const caught = (await transport
      .request('/api/notes')
      .catch((error: unknown) => error)) as AppError;

    expect(caught.errorType).toBe('network');
    expect(caught.message).toBe('Could not reach the server.');
  });

  test('a 204 is an empty body rather than a parse failure', async () => {
    const { transport } = recording(() => new Response(null, { status: 204 }));

    expect(await transport.request('/api/notes/abc', { method: 'DELETE' })).toBeUndefined();
  });
});

describe('credentials are a per-request decision', () => {
  test('the transport default is sent when a call does not choose', async () => {
    const { transport, calls } = recording(() => jsonResponse({}));

    await transport.request('/api/notes');

    expect(calls[0]?.init.credentials).toBe('include');
  });

  test('a call can refuse credentials, and the header set follows it', async () => {
    // The web app's session is a same-origin cookie. A request to a URL derived
    // from anything a user typed must not carry it, and "the transport always
    // includes cookies" is exactly how that leak happens.
    const { transport, calls } = recording(() => jsonResponse({}));

    await transport.request('/api/notes', { credentials: 'omit' });

    expect(calls[0]?.init.credentials).toBe('omit');
  });

  test('no credentials are sent when neither the transport nor the call sets any', async () => {
    const calls: Call[] = [];
    const transport = new HttpTransport({
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return jsonResponse({});
      },
    });

    await transport.request('/api/notes');

    // A native bearer transport has nothing to include, and sending
    // `credentials: 'include'` against a third-party API origin would attach
    // whatever the host has, which is not what "bearer" means.
    expect(calls[0]?.init.credentials).toBeUndefined();
  });
});

describe('a request carries what the call asked for', () => {
  test('the default base URL is same-origin, so a request stays relative', async () => {
    // What the browser gets. A hard-coded `http://127.0.0.1:8787` default was a
    // port that no longer hosts anything and that a deployed build would have
    // shipped into the client bundle as a fixed destination.
    const calls: Call[] = [];
    const transport = new HttpTransport({
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return jsonResponse({});
      },
    });

    await transport.request('/api/notes');

    expect(calls[0]?.url).toBe('/api/notes');
  });

  test('the transport sends no authorization header of its own', async () => {
    // The web session cookie is the only credential this client holds. An
    // `authorization` header here would be a second, unaccounted-for identity
    // path, and its absence is what keeps a future bearer host from creeping the
    // web client into one.
    const { transport, calls } = recording(() => jsonResponse({}));

    await transport.request('/api/auth/get-session');

    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBeNull();
  });

  test('base URL, method, body, trace and extra headers all arrive', async () => {
    const { transport, calls } = recording(() => jsonResponse({}));

    await transport.request('api/notes', {
      method: 'POST',
      body: { title: 'a' },
      traceId: 'trace_1',
      headers: { 'idempotency-key': 'key_1' },
    });

    const headers = new Headers(calls[0]?.init.headers);
    expect(calls[0]?.url).toBe('https://api.example.test/api/notes');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"title":"a"}');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-trace-id')).toBe('trace_1');
    expect(headers.get('idempotency-key')).toBe('key_1');
  });

  test('a body is not declared on a GET', async () => {
    const { transport, calls } = recording(() => jsonResponse({}));

    await transport.request('/api/notes');

    // A `content-type: application/json` on a request with no body is what makes
    // some intermediaries return 400 instead of the list.
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBeNull();
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test('the abort signal is forwarded, so a torn-down screen really cancels', async () => {
    const controller = new AbortController();
    const { transport, calls } = recording(() => jsonResponse({}));

    const pending = transport.request('/api/notes', { signal: controller.signal });
    controller.abort();
    await pending;

    expect(calls[0]?.init.signal).toBe(controller.signal);
  });
});

describe('the byte path, which is deliberately not the JSON path', () => {
  const mp4 = (): Response =>
    new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '8' },
    });

  test('bytes come back as bytes, and the declared length is reported', async () => {
    const { transport } = recording(() => mp4());

    const artifact = await transport.fetchBytes('/api/jobs/job_1/output');

    expect(artifact.bytes.byteLength).toBe(8);
    expect(artifact.contentType).toBe('video/mp4');
    expect(artifact.contentLength).toBe(8);
  });

  test('the JSON path would have destroyed these bytes', async () => {
    // The reason this is a second method. `request()` reads the body as text and
    // parses it, so pointed at a binary body it either throws or returns a
    // truncated string that looks like a successful answer.
    const { transport } = recording(() => mp4());

    const failure = await transport
      .request('/api/jobs/job_1/output')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).errorType).toBe('server');
  });

  test('the credentials decision applies to bytes exactly as it does to JSON', async () => {
    // A media element cannot carry a cookie decision, which is why the bytes come
    // through this method: the same `credentials` the session uses is attached
    // here, and nowhere else.
    const { transport, calls } = recording(() => mp4());

    await transport.fetchBytes('/api/jobs/job_1/output');

    expect(calls[0]?.init.credentials).toBe('include');
  });

  test('a bounded range becomes one Range header, and no range asks for none', async () => {
    const { transport, calls } = recording(() => mp4());

    await transport.fetchBytes('/api/jobs/job_1/output', {
      range: { startInclusive: 0, endInclusive: 1023 },
    });
    await transport.fetchBytes('/api/jobs/job_1/output');

    expect(new Headers(calls[0]?.init.headers).get('range')).toBe('bytes=0-1023');
    expect(new Headers(calls[1]?.init.headers).get('range')).toBeNull();
  });

  test('an expired artifact is a typed refusal, not an empty success', async () => {
    // 410 with the server's envelope. A screen that received an empty Blob here
    // would show a player with nothing in it and call it an encode.
    const { transport } = recording(() =>
      jsonResponse(
        { error: 'output_expired', message: 'That result has passed its retention window.' },
        410,
      ),
    );

    const failure = await transport
      .fetchBytes('/api/jobs/job_1/output')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).status).toBe(410);
    expect((failure as AppError).message).toMatch(/retention/);
  });

  test('an HTML error page from an intermediary keeps the status, not a JSON complaint', async () => {
    const { transport } = recording(
      () =>
        new Response('<html>gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    );

    const failure = await transport
      .fetchBytes('/api/jobs/job_1/output')
      .catch((error: unknown) => error);

    expect((failure as AppError).errorType).toBe('server');
    expect((failure as AppError).status).toBe(502);
  });

  test('an aborted byte fetch is cancellation rather than an outage', async () => {
    const { transport } = recording(() => {
      throw new DOMException('aborted', 'AbortError');
    });

    const failure = await transport
      .fetchBytes('/api/jobs/job_1/output')
      .catch((error: unknown) => error);

    expect(isAbortError(failure)).toBe(true);
  });
});
