// apps/backend/jobs/src/processor_client.test.ts
//
// The processor client, against a **real local HTTP server** that speaks the real
// protocol.
//
// Not a fetch mock. The questions this file answers are all about bytes and
// headers crossing a socket — does the client declare a length, does it notice an
// attempt echo that is not its own, does a refused body become a frozen code — and
// a mocked `fetch` answers none of them, because it hands back a Response the
// client constructed itself. The compute lane separately drives the *real* Rust
// image through this same client; what is checked here is the client's own logic,
// which is why the server is a small script rather than a container.
//
// Each test names the failure it reports, not the function it calls.

import { afterEach, describe, expect, test } from 'bun:test';
import type { ProcessorErrorCode } from '@starter/schemas/jobs';
import {
  createProcessorClient,
  ENCODE_HTTP_DEADLINE_MS,
  type EncodeProcessor,
} from './processor_client.ts';

const MAX_INPUT = 5 * 1024 * 1024;
const MAX_OUTPUT = 10 * 1024 * 1024;

interface ScriptedServer {
  client: EncodeProcessor;
  /** Every request the server saw, in order. */
  requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    bodyBytes: number;
  }>;
  close: () => Promise<void>;
}

const OUTPUT_BYTES = new Uint8Array(1024).fill(7);
const SHA = 'a'.repeat(64);

/**
 * A local server that answers whatever a test tells it to.
 *
 * The default is a *successful* encode with the real protocol's response headers,
 * so a test that changes one thing changes exactly one thing.
 */
const startServer = async (
  respond: (request: Request, body: Uint8Array) => Response | Promise<Response>,
): Promise<ScriptedServer> => {
  const requests: ScriptedServer['requests'] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = new Uint8Array(await request.arrayBuffer());
      requests.push({
        method: request.method,
        url: new URL(request.url).pathname,
        headers: Object.fromEntries(request.headers.entries()),
        bodyBytes: body.byteLength,
      });
      return respond(request, body);
    },
  });

  const client = createProcessorClient({
    fetcher: fetch,
    origin: `http://127.0.0.1:${server.port}`,
    maxInputBytes: MAX_INPUT,
    maxOutputBytes: MAX_OUTPUT,
  });

  return {
    client,
    requests,
    close: async () => {
      await server.stop(true);
    },
  };
};

const successResponse = (
  overrides: { attemptId?: string; headers?: Record<string, string> } = {},
) =>
  new Response(OUTPUT_BYTES, {
    status: 200,
    headers: {
      'content-type': 'video/mp4',
      'x-protocol': 'sample-v1',
      'x-preset': 'demo-180p-v1',
      'x-attempt-id': overrides.attemptId ?? 'attempt-1',
      'x-output-bytes': String(OUTPUT_BYTES.byteLength),
      'x-output-sha256': SHA,
      'x-output-codec': 'h264',
      'x-output-dimensions': '320x180',
      'x-output-duration-ms': '3019',
      ...overrides.headers,
    },
  });

const refusal = (code: string, status: number, retryable: boolean) =>
  new Response(JSON.stringify({ error: { code, message: `${code} happened`, retryable } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const payload = (bytes = 2048): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });

let open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open) {
    await close();
  }
  open = [];
});

const serve = async (
  respond: (request: Request, body: Uint8Array) => Response | Promise<Response>,
): Promise<ScriptedServer> => {
  const started = await startServer(respond);
  open.push(started.close);
  return started;
};

describe('declaring the request', () => {
  test('the encode request carries the frozen protocol, preset, attempt and a length', async () => {
    const { client, requests } = await serve(() => successResponse());
    await client.encode(payload(), {
      preset: 'demo-180p-v1',
      attemptId: 'attempt-1',
      contentLength: 2048,
    });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toBe('/encode');
    expect(request?.headers['x-protocol']).toBe('sample-v1');
    expect(request?.headers['x-preset']).toBe('demo-180p-v1');
    expect(request?.headers['x-attempt-id']).toBe('attempt-1');
    // The processor refuses chunked framing, so the length must be declared.
    expect(request?.headers['content-length']).toBe('2048');
    expect(request?.bodyBytes).toBe(2048);
  });

  test('the request is never sent chunked', async () => {
    // The processor's own refusal for chunked is `unsupported_transfer_encoding`,
    // which is terminal. A client that produced one would burn an attempt on its
    // own framing.
    const { client, requests } = await serve(() => successResponse());
    await client.encode(payload(), {
      preset: 'demo-180p-v1',
      attemptId: 'attempt-1',
      contentLength: 2048,
    });
    expect(requests[0]?.headers['transfer-encoding']).toBeUndefined();
  });

  test('an input over the ceiling is refused here rather than uploaded', async () => {
    // The processor would answer `payload_too_large`, but the bound is this
    // deployment's: refusing before the request means no bytes cross the network
    // and no attempt is spent.
    const { client, requests } = await serve(() => successResponse());
    const outcome = await client.encode(payload(), {
      preset: 'demo-180p-v1',
      attemptId: 'attempt-1',
      contentLength: MAX_INPUT + 1,
    });
    expect(outcome.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  test('an empty input is refused before the request', async () => {
    const { client, requests } = await serve(() => successResponse());
    const outcome = await client.encode(payload(), {
      preset: 'demo-180p-v1',
      attemptId: 'attempt-1',
      contentLength: 0,
    });
    expect(outcome.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

describe('reading a successful answer', () => {
  test('the reported artifact is read from the response headers', async () => {
    const { client } = await serve(() => successResponse());
    const outcome = await client.encode(payload(), {
      preset: 'demo-180p-v1',
      attemptId: 'attempt-1',
      contentLength: 2048,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.artifact).toEqual({
      bytes: OUTPUT_BYTES.byteLength,
      sha256: SHA,
      containerFormat: 'mp4',
      videoCodec: 'h264',
      width: 320,
      height: 180,
      durationMs: 3019,
    });
    // The body is a stream, not an array: the artifact must never be materialised
    // in a step result or in memory.
    expect(outcome.body).toBeInstanceOf(ReadableStream);
  });

  test('bytes for another attempt are refused rather than stored under this one', async () => {
    // The echo mismatch is the whole point: streaming these bytes to this
    // attempt's key would turn one attempt's output into another's artifact.
    const { client } = await serve(() => successResponse({ attemptId: 'attempt-999' }));
    const outcome = await client.encode(payload(), {
      preset: 'demo-180p-v1',
      attemptId: 'attempt-1',
      contentLength: 2048,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('invalid_output');
    expect(outcome.retryable).toBe(false);
  });

  test('bytes for another protocol or preset are refused', async () => {
    const wrongEchoes: Record<string, string>[] = [
      { 'x-protocol': 'sample-v2' },
      { 'x-preset': 'demo-360p-v1' },
    ];
    for (const headers of wrongEchoes) {
      const { client } = await serve(() => successResponse({ headers }));
      const outcome = await client.encode(payload(), {
        preset: 'demo-180p-v1',
        attemptId: 'attempt-1',
        contentLength: 2048,
      });
      expect(outcome.ok).toBe(false);
    }
  });

  test('an unreadable output description is terminal, not retried forever', async () => {
    // A 200 with no hash is a processor this build cannot speak. Retrying it
    // three times costs three container starts and produces the same answer.
    const unreadable: Record<string, string>[] = [
      { 'x-output-sha256': 'not-a-hash' },
      { 'x-output-dimensions': '320' },
      { 'x-output-duration-ms': '0' },
      { 'x-output-bytes': 'lots' },
    ];
    for (const headers of unreadable) {
      const { client } = await serve(() => successResponse({ headers }));
      const outcome = await client.encode(payload(), {
        preset: 'demo-180p-v1',
        attemptId: 'attempt-1',
        contentLength: 2048,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return;
      }
      expect(outcome.code).toBe('invalid_output');
      expect(outcome.retryable).toBe(false);
    }
  });

  test('output over this deployment ceiling is refused before it is stored', async () => {
    const { client } = await serve(() =>
      successResponse({ headers: { 'x-output-bytes': String(MAX_OUTPUT + 1) } }),
    );
    const outcome = await client.encode(payload(), {
      preset: 'demo-180p-v1',
      attemptId: 'attempt-1',
      contentLength: 2048,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('output_too_large');
    expect(outcome.retryable).toBe(false);
  });
});

describe('classifying a refusal', () => {
  test('invalid media ends the attempt rather than spending the retry budget', async () => {
    // Retrying undecodable bytes three times buys a deterministic failure three
    // times over, and each one is a container start.
    const { client } = await serve(() => refusal('invalid_media', 400, false));
    const outcome = await client.encode(payload(), {
      preset: 'demo-180p-v1',
      attemptId: 'attempt-1',
      contentLength: 2048,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('invalid_media');
    expect(outcome.message).toBe('The processor refused the request.');
    expect(outcome.retryable).toBe(false);
  });

  test('an unknown preset ends the attempt', async () => {
    const { client } = await serve(() => refusal('unsupported_preset', 400, false));
    const outcome = await client.encode(payload(), {
      preset: 'demo-180p-v1',
      attemptId: 'attempt-1',
      contentLength: 2048,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('unsupported_preset');
    expect(outcome.retryable).toBe(false);
  });

  test('busy and a deadline are worth sending the same bytes again', async () => {
    const retryable: ProcessorErrorCode[] = ['busy', 'deadline_exceeded', 'internal_error'];
    for (const code of retryable) {
      const { client } = await serve(() => refusal(code, code === 'busy' ? 429 : 503, true));
      const outcome = await client.encode(payload(), {
        preset: 'demo-180p-v1',
        attemptId: 'attempt-1',
        contentLength: 2048,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return;
      }
      expect(outcome.code).toBe(code as ProcessorErrorCode);
      expect(outcome.retryable).toBe(true);
    }
  });

  test('a refusal body this build cannot read is a transport problem', async () => {
    // The retry decision is made from the code, so an unparseable answer must not
    // be guessed at from an HTTP status.
    const { client } = await serve(
      () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );
    const outcome = await client.encode(payload(), {
      preset: 'demo-180p-v1',
      attemptId: 'attempt-1',
      contentLength: 2048,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('internal_error');
    expect(outcome.retryable).toBe(true);
    // Provider text never becomes this repository's message.
    expect(outcome.message).not.toContain('Bad Gateway');
  });

  test('a processor that cannot be reached is retryable', async () => {
    // Port 1 on loopback refuses immediately, so this is a real connection
    // failure rather than a simulated one.
    const client = createProcessorClient({
      fetcher: fetch,
      origin: 'http://127.0.0.1:1',
      maxInputBytes: MAX_INPUT,
      maxOutputBytes: MAX_OUTPUT,
    });
    const outcome = await client.encode(payload(), {
      preset: 'demo-180p-v1',
      attemptId: 'attempt-1',
      contentLength: 2048,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('internal_error');
    expect(outcome.retryable).toBe(true);
  });

  test('a request that outlives the deadline is given up on rather than held open', async () => {
    // The HTTP deadline is this Worker's contract with the network; the
    // processor's 120 s process deadline is its own. A hung socket must not pin a
    // Workflow step for the platform's longer step timeout.
    //
    // The server deliberately answers *after* the deadline has fired, so this
    // waits for the server's own view of the request as well as the client's.
    // Asserting only the client's answer would pass even if no abort signal ever
    // reached the socket.
    let sawAbort: boolean | null = null;
    const serverFinished = Promise.withResolvers<void>();
    const { client } = await serve(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      sawAbort = request.signal.aborted;
      serverFinished.resolve();
      return successResponse();
    });

    const started = Date.now();
    const outcome = await client.encode(
      payload(),
      { preset: 'demo-180p-v1', attemptId: 'attempt-1', contentLength: 2048 },
      50,
    );
    expect(outcome.ok).toBe(false);
    // It gave up on the deadline rather than waiting for the answer.
    expect(Date.now() - started).toBeLessThan(150);

    await serverFinished.promise;
    expect(sawAbort ?? false).toBe(true);
  });

  test('the default encode deadline outlives the processor process deadline', () => {
    // If these two ever cross, a slow encode would be abandoned by this client
    // while the processor was still working, and the retry would double the CPU.
    expect(ENCODE_HTTP_DEADLINE_MS).toBeGreaterThan(120_000);
  });
});

describe('liveness', () => {
  test('a processor speaking this protocol is accepted', async () => {
    const { client } = await serve(() =>
      Response.json({
        release: 'test',
        protocol: 'sample-v1',
        fixture: 'sample-v1',
        presets: [],
        limits: {},
      }),
    );
    const health = await client.health();
    expect(health?.protocol).toBe('sample-v1');
  });

  test('a processor speaking another protocol is refused, not encoded through', async () => {
    const { client } = await serve(() =>
      Response.json({
        release: 'test',
        protocol: 'sample-v2',
        fixture: 'sample-v1',
        presets: [],
        limits: {},
      }),
    );
    expect(await client.health()).toBeNull();
  });

  test('an unreachable processor reports no health rather than throwing', async () => {
    const client = createProcessorClient({
      fetcher: fetch,
      origin: 'http://127.0.0.1:1',
      maxInputBytes: MAX_INPUT,
      maxOutputBytes: MAX_OUTPUT,
    });
    expect(await client.health()).toBeNull();
  });
});
