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

import { type ApiTransport, HttpTransport, type TransportRequestOptions } from '@starter/platform';

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
  /** Injected so a test replaces it rather than the global. */
  readonly fetch?: typeof globalThis.fetch;
  readonly className?: string;
}

/**
 * Wrap a transport so every call carries the current bearer token.
 *
 * `null` token means "no credential": the request goes out unauthenticated and
 * the API answers 401, which is the same answer a signed-out browser gets. It
 * does not throw, because "not signed in yet" is a state the sign-in screen has
 * to render, not an error.
 */
export const createBearerTransport = (options: BearerTransportOptions): ApiTransport => {
  const inner = new HttpTransport({
    baseUrl: options.origin,
    credentials: 'omit',
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    className: options.className ?? 'NativeBearerTransport',
  });

  return {
    request: <T>(path: string, requestOptions: TransportRequestOptions = {}): Promise<T> => {
      const token = options.getToken();

      return inner.request<T>(path, {
        credentials: 'omit',
        ...requestOptions,
        // Caller headers first, then the credential: a per-call `authorization`
        // header is not a thing any caller has, and letting one through would be
        // a way to present somebody else's token.
        headers: {
          ...requestOptions.headers,
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
      });
    },
  };
};
