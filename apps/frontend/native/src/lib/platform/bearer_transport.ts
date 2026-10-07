// apps/frontend/native/src/lib/platform/bearer_transport.ts
//
// The native host's answer to `ApiTransport`: an absolute origin plus a bearer
// token.
//
// The web host's answer is `HttpTransport({ credentials: 'include' })` against a
// relative path, because the Worker serves the page, the assets and `/api/*` from
// one origin and the browser holds the cookie. Neither of those is true here: this
// bundle is a file inside the binary, and it has no cookie jar to include. So the
// same features call the same service through a different decorator, and the only
// host-specific code in the whole frontend is this file plus its two siblings.
//
// Three properties, each load-bearing:
//
//   1. **`credentials: 'omit'`.** A native client has no cookies to send, and
//      `include` against a third-party origin would attach whatever the webview
//      happened to hold for that host. Setting it per call rather than only at
//      construction is what makes a deliberate override impossible to forget.
//   2. **The token is read per request, not captured.** A transport that read the
//      token once would keep presenting a revoked credential after sign-out, and
//      the failure is invisible: every request 401s and the app looks broken
//      rather than signed out.
//   3. **No token is logged, stored on the instance, or placed in a URL.** The
//      header is the only place it appears, which is why this is a decorator over
//      the shared transport rather than a hand-written `fetch` loop.

import {
  type ArtifactBytes,
  type ArtifactRequestOptions,
  type ArtifactTransport,
  HttpTransport,
  type StreamingTransport,
  type TransportRequestOptions,
} from '@starter/platform';

/**
 * Where the current credential comes from.
 *
 * Synchronous on purpose: it is a memory read on the hot path of every request,
 * and it is the composition root's in-memory session, not an await. Persistence
 * happens once, when signing in.
 */
export type TokenReader = () => string | null;

export interface BearerTransportOptions {
  /** Absolute origin, already validated by `#lib/runtime/config.ts`. */
  readonly origin: string;
  readonly getToken: TokenReader;
  /** Refresh only when the current access token is near expiry. */
  readonly beforeRequest?: () => Promise<void>;
  /** Injected so a test replaces it rather than the global. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Wrap a transport so every call carries the current bearer token.
 *
 * `null` token means "no credential": the request goes out unauthenticated and
 * the API answers 401, which is the same answer a signed-out browser gets. It
 * does not throw, because "not signed in yet" is a state the sign-in screen has
 * to render, not an error.
 *
 * The byte path is delegated rather than rebuilt, for one reason that matters more
 * than the DRY: a `<video>` element issues its own request with no header, so the
 * encoded result has to come *through* this decorator. Delegation means the
 * credential is attached in a header and nowhere else — no token in a URL, no
 * second code path that could forget it.
 */
export const createBearerTransport = (
  options: BearerTransportOptions,
): ArtifactTransport & StreamingTransport => {
  const inner = new HttpTransport({
    baseUrl: options.origin,
    credentials: 'omit',
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  const authenticated = (headers: Readonly<Record<string, string>> | undefined) => {
    const result = new Headers(headers);
    result.delete('authorization');
    const token = options.getToken();
    if (token !== null) {
      result.set('authorization', `Bearer ${token}`);
    }
    return Object.fromEntries(result);
  };

  return {
    request: async <T>(path: string, requestOptions: TransportRequestOptions = {}): Promise<T> => {
      await options.beforeRequest?.();
      return inner.request<T>(path, {
        ...requestOptions,
        credentials: 'omit',
        headers: authenticated(requestOptions.headers),
      });
    },
    fetchBytes: async (
      path: string,
      requestOptions: ArtifactRequestOptions = {},
    ): Promise<ArtifactBytes> => {
      await options.beforeRequest?.();
      return inner.fetchBytes(path, {
        ...requestOptions,
        credentials: 'omit',
        headers: authenticated(requestOptions.headers),
      });
    },
    openStream: async (
      path: string,
      requestOptions: TransportRequestOptions = {},
    ): Promise<Response> => {
      await options.beforeRequest?.();
      return inner.openStream(path, {
        ...requestOptions,
        credentials: 'omit',
        headers: authenticated(requestOptions.headers),
      });
    },
  };
};
