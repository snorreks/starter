// apps/frontend/client/src/hooks.server.ts
//
// The composition root.
//
// One Worker serves the HTML, the assets and the API, so this is the single
// place every request is given its configuration and its identity. Three jobs,
// in this order, and the order is the design:
//
//   1. **Bindings -> container.** `cloudflare:workers` is the documented source
//      for Worker bindings under `@sveltejs/adapter-cloudflare`: the real module
//      in a deployed Worker, and the emulated binding set read from
//      `wrangler.jsonc` (D1 included) under `vite dev` and `vite preview`. The
//      container is memoized per binding set and origin, which are the two things
//      a container is actually derived from; see `#lib/server/container.ts` for
//      why request identity is not.
//
//   2. **Request -> identity.** `locals.user` is resolved from the session on
//      every single request and lives nowhere else. There is no module variable
//      and no `setUserForRequest`, because a Worker isolate serves concurrent
//      requests and the last writer would win for all of them.
//
//   3. **Unrouted `/api/*` is a JSON 404.** SvelteKit's own fallback for an
//      unmatched route is an HTML error page. An API client that asked for
//      `/api/no-such-route` and got HTML has to guess why, and the two plausible
//      guesses — wrong URL, or a broken deploy — are both expensive. A genuine
//      404 with the same `{ error, message }` shape as every other API response
//      is unambiguous.
//
// A configuration failure is caught here rather than allowed to escape. An
// uncaught throw reaches the caller as a generic 500 whose body says nothing
// about which binding is missing, which is exactly what a misconfigured deploy
// produces. This response names the problem and contains no secret.

import { env } from 'cloudflare:workers';
import { createLogger } from '@starter/logger';
// `Handle` from `@sveltejs/kit/hooks`, not from a generated `./$types`.
//
// This is a real difference from the route files, and it is the documented
// pattern: `./$types` is generated per *route*, and `hooks.server.ts` is not a
// route, so there is no generated module to import from. `Handle` is exported from
// the `@sveltejs/kit/hooks` subpath (it is *not* on the package root in Kit 3 —
// checked against the installed types rather than assumed) and that is where the
// hook's own type lives.
import type { RequestEvent } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { type Container, getContainer } from '#lib/server/container.ts';
import { jsonError, notConfigured } from '#lib/server/http.ts';
import { resolveUser } from '#lib/server/request_context.ts';

/** Refuses to start, loudly, before a Worker logs anything. */
const startupLogger = createLogger({
  app: 'web',
  environment: 'local',
  source: 'worker',
  release: 'dev',
  logLevel: 'INFO',
  // `false` in local development on purpose: a silent logger means a 503 with an
  // empty body is undebuggable. Deployed, the platform captures console output, so
  // a second write would only double-count.
  silent: typeof process !== 'undefined' && process.env.NODE_ENV === 'production',
});

const isApiPath = (pathname: string): boolean =>
  pathname === '/api' || pathname.startsWith('/api/');

/**
 * The origin this request actually arrived on, for local origin derivation.
 *
 * Prefer Host when the runtime preserves it, falling back to `event.url.origin`.
 * Wrangler 4.142.0 with the launcher's `--host 127.0.0.1` rewrites both the URL and
 * Host to omit the browser's port; this helper cannot recover that port. The
 * launcher supplies `BETTER_AUTH_URL` with the public origin for that reason.
 * Without `--host`, Wrangler preserves the port in both the URL and Host.
 *
 * This is only a candidate for local loopback derivation. Deployed environments
 * require `BETTER_AUTH_URL`, and a non-loopback candidate is refused locally.
 */
const requestOriginFor = (event: RequestEvent): string => {
  const host = event.request.headers.get('host');
  if (host !== null && host.length > 0) {
    return `${event.url.protocol}//${host}`;
  }
  return event.url.origin;
};

export const handle: Handle = async ({ event, resolve }) => {
  // Typed rather than inferred from `undefined`: the whole point of the try is that
  // the assignment may not happen, and an inferred type would be the failure mode
  // this hook exists to turn into a readable response.
  let container: Container;
  try {
    container = getContainer(env, requestOriginFor(event));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    startupLogger.error('config.invalid', { message });
    return notConfigured(message, isApiPath(event.url.pathname));
  }

  event.locals.container = container;
  // Per request, from this request. See the header comment.
  event.locals.user = await resolveUser(container, event.request.headers);

  const response = await resolve(event);

  // `route.id` is null exactly when nothing matched, which is what makes this a
  // 404 rather than a guess about the response status.
  if (event.route.id === null && isApiPath(event.url.pathname)) {
    return jsonError(404, 'not_found', 'No such route.');
  }

  // Cache policy, applied here rather than per route.
  //
  // Two classes of response, and they must not be confused:
  //
  //   * **Session-dependent** — anything behind a sign-in, and every `/api/*`
  //     response, authenticated or not. `private, no-store` says both halves: not
  //     for a shared cache, and not for the browser either. A `Cache-Control:
  //     public` on a page rendered with a session user is one CDN configuration
  //     change away from serving one user's notes to another.
  //   * **Anonymous HTML** — the landing page and the auth screens. These *could*
  //     be cached, and are deliberately left to the deployment's own asset
  //     headers rather than being declared cacheable here. A blanket `public`
  //     would be a correctness claim this code cannot verify, since whether a page
  //     is anonymous depends on the session rather than on the URL.
  //
  // Headers are copied rather than mutated: a `Response` from SvelteKit is often
  // immutable, and assigning to `.headers` throws in workerd when it is.
  const policy = cachePolicyFor(event.url.pathname, event.locals.user);
  if (policy !== null) {
    const headers = new Headers(response.headers);
    headers.set('cache-control', policy);
    return new Response(response.body, { status: response.status, headers });
  }

  return response;
};

/**
 * The `Cache-Control` for one request, or `null` to leave the response alone.
 *
 * Exported so the rule is assertable directly rather than only through a hook that
 * needs a whole request to reach it.
 */
export const cachePolicyFor = (pathname: string, user: unknown): string | null => {
  if (isApiPath(pathname)) {
    return PRIVATE;
  }
  if (user !== null && user !== undefined) {
    return PRIVATE;
  }
  if (isHealthPath(pathname)) {
    // `/health` sets its own `no-store`; restating it here keeps the policy in one
    // place for anyone auditing it, and costs nothing.
    return NO_STORE;
  }
  return null;
};

/** Not for a shared cache, and not for the browser. */
const PRIVATE = 'private, no-store, max-age=0';

/** Not cached at all, by anyone. */
const NO_STORE = 'no-store';

const isHealthPath = (pathname: string): boolean =>
  pathname === '/health' || pathname === '/health/ready';
