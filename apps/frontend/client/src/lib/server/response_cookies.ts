// apps/frontend/client/src/lib/server/response_cookies.ts
//
// Move `Set-Cookie` headers off a response a SvelteKit action cannot return.
//
// Why this file exists
// --------------------
// Supabase Auth's server-side API sets its cookies on the response *it* produces. A
// SvelteKit action cannot return that response — `Actions`' output type is a plain
// object or `void`, not a `Response` — so an action that calls `auth.api` and drops
// the headers completes a sign-in that reports success, redirects correctly, and hands
// the browser no session at all.
//
// The failure is invisible where it happens. The redirect is right, the status is
// right, and the very next request is simply not signed in, which reads as a broken
// session check rather than as a cookie that was never sent. `event.cookies` is the
// only way an action can set one, so every `Set-Cookie` is parsed and re-applied here.
//
// Why the framework's parser, and not a local one
// ----------------------------------------------
// Supabase Auth's session cookie is already percent-encoded — its signature ends in `%3D`.
// A parser that split the header by hand and handed the raw value to `cookies.set`
// would have that value encoded a second time by SvelteKit's serializer, and the
// session token the server read back would differ from the one that was signed. The
// symptom is again the invisible one: a cookie is stored, and it authenticates nothing.
//
// `cookies.parse` is `cookie.parseSetCookie` with SvelteKit's defaults, which is what
// SvelteKit's own documentation prescribes for a cookie received from another service.
// Decoding there and re-encoding on the way out is a round trip, not a second encoding.

import type { Cookies } from '@sveltejs/kit';

/**
 * The part of `event.cookies` this file uses.
 *
 * `Pick`ed from SvelteKit's own `Cookies` rather than re-declared, so the signatures
 * cannot drift from what the framework actually passes — and narrowed to two members so
 * the forwarding can be tested with a stub instead of a constructed request event.
 * `parse` is SvelteKit's; it is here because the code calls it.
 */
export type CookieSink = Pick<Cookies, 'set' | 'parse'>;

/**
 * Apply every `Set-Cookie` on `headers`, and report how many there were.
 *
 * A count rather than `void`, so a caller can tell a sign-in that started a session from
 * one that reported success without setting a cookie. Zero is the case worth catching:
 * it is indistinguishable from success at every other point in the request.
 *
 * `headers.getSetCookie()` rather than `headers.get('set-cookie')`, which returns one
 * comma-joined string that cannot be split reliably — a cookie value may contain a
 * comma. Getting this wrong silently applies only the first cookie of several.
 */
export const applySetCookies = (cookies: CookieSink, headers: Headers): number => {
  let applied = 0;

  for (const setCookie of headers.getSetCookie()) {
    const { name, value, ...options } = cookies.parse(setCookie);

    // `parse` leaves `value` undefined only for a header that is not `name=value` at all.
    // A cookie with an *empty* value — which is how a deletion is expressed — parses to
    // `''` and is applied, so this is not a deletion being skipped. Counting only what
    // was applied keeps the number the caller checks meaningful.
    if (value === undefined) {
      continue;
    }

    cookies.set(name, value, options);
    applied += 1;
  }

  return applied;
};
