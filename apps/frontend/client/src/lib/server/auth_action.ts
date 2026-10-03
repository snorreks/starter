// apps/frontend/client/src/lib/server/auth_action.ts
//
// The one way a form action talks to Better Auth.
//
// Why this file exists: it must go through `auth.handler`, not `auth.api`
// ---------------------------------------------------------------------
// Both are Better Auth. They are not the same boundary.
//
// `auth.api.<endpoint>({ body })` calls the endpoint function directly. It runs the
// endpoint's own logic and nothing else. `auth.handler(request)` routes a `Request`
// through the whole stack — the origin check, the IP resolver, and the rate
// limiter — before the endpoint runs.
//
// So an action that called `auth.api` directly was an action with **no rate limit
// and no origin check**. The limiter this repository spent a migration and a
// D1-backed storage implementation on protected the browser's `fetch` and not the
// form submission, which is the one an attacker reaches by disabling JavaScript.
// The browser-side path is the same `auth.api`-vs-`handler` question and was always
// answered by a real HTTP request to `/api/auth/...`.
//
// A form action cannot issue an HTTP request to its own origin — that is a second,
// differently-authenticated path to the same endpoint, which this repository's
// architecture doc rules out. So the action re-issues the request *internally*,
// through the handler, with the browser's own headers.
//
// What is forwarded, and why
// --------------------------
// Every incoming header, measured rather than assumed: `Origin`,
// `CF-Connecting-IP` and `Cookie` all survive `new Headers(request.headers)`, as
// does `Host`. Those first three are exactly what the origin check and the rate
// limiter read, and dropping them would re-open the hole this file exists to close.
// `Host` riding along is harmless — the origin check compares `Origin` against the
// trusted list, never `Host` — and keeping it makes this a faithful re-issue of the
// request rather than a partly-rewritten one.
//
// `Content-Length` is deleted and nothing else is. It is the one header that is
// actively wrong here: the body is being replaced with different bytes, and a stale
// length on a request with a body is a request the runtime may reject or truncate.
//
// The cookies go on the *action's* response, because a SvelteKit action cannot return
// a `Response` — see `response_cookies.ts`. They are applied before the failure check
// on purpose: an endpoint that refuses a sign-in may still clear a session cookie, and
// silently keeping a cookie the server just invalidated is the worse of the two.

import { AppError, errorTypeForStatus } from '@starter/utils';
import type { Cookies } from '@sveltejs/kit';
import type { Container } from './container.ts';
import { applySetCookies } from './response_cookies.ts';

/**
 * The Better Auth endpoints a form action may reach.
 *
 * Closed on purpose. This is the surface a no-script submission can touch, so it is
 * enumerated rather than accepted as a string: a typo in a path would otherwise become
 * a 404 from Better Auth's own router, reported to the user as "could not complete that
 * request", and a fifth endpoint could be added by accident rather than by decision.
 */
export type AuthActionPath =
  | 'sign-in/email'
  | 'sign-up/email'
  | 'send-verification-email'
  | 'request-password-reset'
  | 'reset-password';

/**
 * Submit a form's credentials to `path`, and return how many cookies were applied.
 *
 * The count is the caller's signal that a session actually started. `auth-lifecycle`
 * callers assert on it: a sign-in that reports success and sets no cookie is a
 * redirect to a page that bounces straight back.
 *
 * @throws {AppError} carrying Better Auth's own status and body, so the caller can map
 *   429 to "wait a minute" and 403 to "confirm your address" without re-parsing a
 *   message.
 */
export const submitAuthAction = async (
  container: Container,
  request: Request,
  cookies: Cookies,
  path: AuthActionPath,
  body: Record<string, string>,
): Promise<number> => {
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');

  const response = await container.auth.handler(
    new Request(new URL(`/api/auth/${path}`, container.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );

  const applied = applySetCookies(cookies, response.headers);

  if (!response.ok) {
    // Better Auth's error body, kept as the cause rather than as the message. The
    // message is this application's, because Better Auth's own distinguishes a wrong
    // password from an unknown address and forwarding that turns this form into an
    // account-existence oracle.
    const cause: unknown = await response.json().catch(() => undefined);
    throw new AppError(errorTypeForStatus(response.status), 'Could not complete that request.', {
      status: response.status,
      cause,
    });
  }

  return applied;
};

// ── Device authorization ─────────────────────────────────────────────────────
//
// The web half of the native client's sign-in: a page where a signed-in user
// approves or denies a short code. It re-issues through `auth.handler` for exactly
// the reason the header describes — an `auth.api` call here would skip the origin
// check and the rate limiter, and this page is reachable without JavaScript.
//
// Two facts about the pinned plugin shape this file, because both are easy to get
// wrong and neither is discoverable from the route names:
//
//   1. `GET /api/auth/device?user_code=…` **claims** the code. It sets the record's
//      user id from the current session. Without that call, `device/approve`
//      answers 403 — "not claimed by a verifying session" — and the page looks
//      broken rather than wrong.
//   2. `POST /api/auth/device/approve` and `/deny` take `{ userCode }`, camelCase,
//      while the `GET` query is `user_code`. Same word, two spellings, from the
//      same plugin.

/** The two device endpoints a form action may reach. Both are POST. */
export type DeviceActionPath = 'device/approve' | 'device/deny';

/**
 * Ask Better Auth what state a user code is in.
 *
 * A `GET`, through the handler, because the claim above is what makes a later
 * approval possible and skipping it produces a 403 the user cannot act on.
 *
 * Returns the provider's answer, or `null` when the code is unknown or already
 * spent. `null` rather than a throw: "that code is not valid" is a state this page
 * renders, and an exception would arrive in the error boundary as a 500.
 */
export const readDeviceAuthorization = async (
  container: Container,
  request: Request,
  userCode: string,
): Promise<DeviceAuthorizationState | null> => {
  const url = new URL('/api/auth/device', container.baseUrl);
  url.searchParams.set('user_code', userCode);

  const response = await container.auth.handler(
    new Request(url, { method: 'GET', headers: new Headers(request.headers) }),
  );

  if (!response.ok) {
    return null;
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const candidate = body as { user_code?: unknown; status?: unknown; client_id?: unknown };
  if (typeof candidate.user_code !== 'string' || typeof candidate.status !== 'string') {
    return null;
  }

  return {
    userCode: candidate.user_code,
    status: candidate.status,
    clientId: typeof candidate.client_id === 'string' ? candidate.client_id : null,
  };
};

/** What the provider says about one code, projected onto three fields. */
export interface DeviceAuthorizationState {
  readonly userCode: string;
  /** `pending` before a decision; the plugin's own vocabulary, not invented here. */
  readonly status: string;
  readonly clientId: string | null;
}

/**
 * Approve or deny a code this signed-in user claimed.
 *
 * The body is built here rather than passed in, so the plugin's camelCase field
 * name appears exactly once and a caller cannot send the snake_case one that the
 * endpoint ignores.
 */
export const submitDeviceAction = async (
  container: Container,
  request: Request,
  cookies: Cookies,
  path: DeviceActionPath,
  userCode: string,
): Promise<number> => {
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');

  const response = await container.auth.handler(
    new Request(new URL(`/api/auth/${path}`, container.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ userCode }),
    }),
  );

  applySetCookies(cookies, response.headers);

  if (!response.ok) {
    const cause: unknown = await response.json().catch(() => undefined);
    throw new AppError(errorTypeForStatus(response.status), 'Could not complete that request.', {
      status: response.status,
      cause,
    });
  }

  return response.status;
};
