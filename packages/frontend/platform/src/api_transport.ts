// packages/frontend/platform/src/api_transport.ts
//
// The one HTTP seam between a feature and the network.
//
// Why an interface and not a client
// ---------------------------------
// The reusable question is "how do I reach the API", and every host answers it
// differently. A browser on the deployed web origin sends the session cookie
// with `credentials: 'include'` and resolves relative paths. A native shell has
// no cookie jar at all and must present a bearer token against an absolute
// origin. Both are the same feature calling the same service.
//
// So the feature depends on `ApiTransport` — three options in, one value out —
// and a *composition root* decides what fulfils it. That decision is the only
// part that is host-specific, and it lives in the application, not here: this
// package must load in every host, which means it may not know about `$app`,
// about a cookie, or about `@tauri-apps/*`.
//
// What the transport deliberately does not do
// --------------------------------------------
// It does not know what a `Note` or a `SessionUser` is. `request<T>` is a
// transport, and the `T` it returns is asserted by the caller against a
// TypeBox schema at the contract boundary — see `dto.ts`. Casting a body to `T`
// inside the transport would move the one place a wrong shape can enter the
// application into the one place that has no schema to check it against.
//
// One method is *not* JSON, and says so in its own type: `fetchBytes` is how a
// feature asks for bytes rather than a document. It exists on a separate
// `ArtifactTransport` interface because `request<T>` is a JSON transport by
// contract — pointed at an MP4 it would either throw or hand back a truncated
// string that reads as success. See `ArtifactTransport`.

import { AppError, errorTypeForStatus } from '@starter/utils';

export type TransportMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Everything one call may vary. Injected per call rather than per transport. */
export interface TransportRequestOptions {
  readonly method?: TransportMethod;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Extra headers for this call. Merged over the transport's own defaults. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Correlates this call with a log event. */
  readonly traceId?: string;
  /**
   * Overrides the transport's credentials mode for this call.
   *
   * Present because "am I allowed to send a cookie" is a per-request decision,
   * not a per-transport one: a same-origin request carries the session, and a
   * request to a URL derived from something a user typed must not.
   */
  readonly credentials?: RequestCredentials;
}

/**
 * The contract every feature's service is written against.
 *
 * Small on purpose. It is the part of `fetch` this repository actually uses, so a
 * fake in a test is four lines and a real transport in production is one class.
 */
/** A streamed response opened using the same host policy as JSON and bytes. */
export interface StreamingTransport extends ApiTransport {
  openStream(path: string, options?: TransportRequestOptions): Promise<Response>;
}

export interface ApiTransport {
  request<T>(path: string, options?: TransportRequestOptions): Promise<T>;
}

/**
 * A transport that can also return *bytes*.
 *
 * A separate interface rather than a method on `ApiTransport`, and the reason is
 * that `request<T>` is a JSON transport: it parses the response body as text and
 * then as JSON. Pointed at an MP4 it produces a `TypeError` or, worse, a truncated
 * string that looks like a successful answer. Rather than teach every JSON call
 * site about binary responses, the byte path is a distinct capability a feature
 * asks for by type — so a host that cannot serve one cannot construct the feature.
 */
export interface ArtifactTransport extends ApiTransport {
  /**
   * Fetch binary bytes.
   *
   * `range` is a bounded, already-validated slice; there is no unbounded "give me
   * everything" form beyond omitting it, and the caller owns the ceiling.
   */
  fetchBytes(path: string, options?: ArtifactRequestOptions): Promise<ArtifactBytes>;
}

/** One byte fetch, and only what varies about one. */
export interface ArtifactRequestOptions {
  readonly credentials?: RequestCredentials;
  readonly signal?: AbortSignal;
  /** Inclusive on both ends, per RFC 9110. */
  readonly range?: { startInclusive: number; endInclusive: number };
  /**
   * Extra headers for this call, merged over the transport's own.
   *
   * Present because a decorator has to be able to add a credential to a byte
   * request the same way it adds one to a JSON request — a native shell's bearer
   * token is a header, and this is the only place a byte request can carry one.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ArtifactBytes {
  readonly bytes: Uint8Array;
  /** What the server said it is. Not trusted for anything but the file name. */
  readonly contentType: string;
  /** The server's own `content-length`, or null when it sent none. */
  readonly contentLength: number | null;
}

/**
 * The part of `fetch` this transport actually uses.
 *
 * Narrower than `typeof fetch` on purpose. Bun adds `fetch.preconnect`, so
 * `typeof fetch` means something different in the Bun unit lane than in a
 * browser, and a fake built to satisfy it would need a cast to be correct.
 * Naming the requirement instead makes the fake's shape exact.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HttpTransportOptions {
  /**
   * Absolute origin of the API, or `''` for "same origin, use relative URLs".
   *
   * `''` is the web application's answer: the Worker serves the HTML, the assets
   * and `/api/*` from one origin, so a relative URL keeps the session cookie
   * first-party without a `credentials` decision at the call site.
   */
  readonly baseUrl?: string;
  /**
   * Injected so a test replaces it rather than the global.
   *
   * Defaults to the global at *call* time, not at construction, so a test that
   * replaces `globalThis.fetch` before constructing still gets its fake.
   */
  readonly fetch?: FetchLike;
  /** Sent on every call. `include` is what makes a web session behave locally and deployed. */
  readonly credentials?: RequestCredentials;
  /** Sent on every call, under the call's own headers. */
  readonly headers?: Readonly<Record<string, string>>;
}

// All response modes open through one host-policy and status-classification path.
export class HttpTransport implements ArtifactTransport, StreamingTransport {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #credentials: RequestCredentials | undefined;
  readonly #headers: Readonly<Record<string, string>> | undefined;

  constructor(options: HttpTransportOptions = {}) {
    this.#baseUrl = options.baseUrl ?? '';
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#credentials = options.credentials;
    this.#headers = options.headers;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async #open(path: string, options: TransportRequestOptions, accept: string): Promise<Response> {
    const headers = new Headers(this.#headers);
    headers.set('accept', accept);
    if (options.body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    if (options.traceId !== undefined) {
      headers.set('x-trace-id', options.traceId);
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headers.set(name, value);
    }
    const mode = options.credentials ?? this.#credentials;
    const url = `${this.#baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(mode === undefined ? {} : { credentials: mode }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      throw normalizeTransportError(error, options.signal);
    }
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = JSON.parse(await response.text());
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw normalizeTransportError(error, options.signal);
        }
      }
      const message =
        typeof payload === 'object' &&
        payload !== null &&
        'message' in payload &&
        typeof payload.message === 'string' &&
        payload.message.trim().length > 0
          ? payload.message
          : 'The request failed.';
      throw new AppError(errorTypeForStatus(response.status), message, {
        status: response.status,
        cause: payload,
      });
    }
    return response;
  }

  async request<T>(path: string, options: TransportRequestOptions = {}): Promise<T> {
    const response = await this.#open(path, options, 'application/json');
    if (response.status === 204) {
      return undefined as T;
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw normalizeTransportError(error, options.signal);
    }
    if (text.length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AppError('server', 'The server returned a response that was not JSON.', {
        status: response.status,
      });
    }
  }

  async fetchBytes(path: string, options: ArtifactRequestOptions = {}): Promise<ArtifactBytes> {
    const headers = new Headers(options.headers);
    if (options.range !== undefined) {
      headers.set('range', `bytes=${options.range.startInclusive}-${options.range.endInclusive}`);
    }
    const response = await this.#open(
      path,
      { ...options, headers: Object.fromEntries(headers) },
      'application/octet-stream',
    );
    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (error) {
      throw normalizeTransportError(error, options.signal);
    }
    const declared = response.headers.get('content-length');
    return {
      bytes: new Uint8Array(buffer),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      contentLength: declared === null ? null : Number(declared),
    };
  }

  async openStream(path: string, options: TransportRequestOptions = {}): Promise<Response> {
    const response = await this.#open(path, options, 'text/event-stream');
    if (response.body === null) {
      throw new AppError('server', 'The server sent a reply with no body.', {
        status: response.status,
      });
    }
    // Normalize failures that occur after headers and cancel the source reader on abort.
    const reader = response.body.getReader();
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      options.signal?.removeEventListener('abort', abort);
      reader.releaseLock();
    };
    let output: ReadableStreamDefaultController<Uint8Array>;
    const abort = () => {
      if (released) {
        return;
      }
      output.error(
        normalizeTransportError(new DOMException('cancelled', 'AbortError'), options.signal),
      );
      void reader
        .cancel()
        .catch(() => {})
        .finally(release);
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) {
          abort();
        }
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (released || options.signal?.aborted) {
            return;
          }
          if (done) {
            controller.close();
            release();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          if (!released && !options.signal?.aborted) {
            controller.error(normalizeTransportError(error, options.signal));
            release();
          }
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

/** Classify both opening and consuming a response; keep cancellation distinct from outages. */
export const normalizeTransportError = (error: unknown, signal?: AbortSignal): AppError => {
  if (error instanceof AppError) {
    return error;
  }
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new AppError('aborted', 'The request was cancelled.', { cause: error });
  }
  return new AppError('network', 'Could not reach the server.', { cause: error });
};
