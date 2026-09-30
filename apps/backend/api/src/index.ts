// apps/backend/api/src/index.ts
//
// The API. One Elysia app, one router.
//
// This is the shared application backend: the browser SPA and the Tauri client
// both talk to it over HTTP with a session cookie or a bearer token. There are
// deliberately no SvelteKit server actions — an action is reachable only from a
// form post on the page that declared it, so it cannot serve a native client,
// and "works on the web, unreachable from Tauri" is a bad property for a
// foundation to have.
//
// CORS is implemented inline rather than with a plugin for one reason: the
// trusted-origin allowlist comes from a Worker binding, and a plugin's static
// config is evaluated before any binding exists. Thirty readable lines that can
// read the container beat a plugin that cannot.

import { createLogger } from '@starter/logger';
import { isTrustedOrigin, parseTrustedOrigins } from '@starter/schemas/registry';
import { Elysia } from 'elysia';
import { type Container, getContainer } from './lib/container.ts';
import { notesRoutes } from './lib/notes.ts';
import { buildRequestContext, unauthorized } from './lib/request_context.ts';
import { telemetryRoutes } from './lib/telemetry.ts';

const CORS_ALLOWED_HEADERS = 'content-type, authorization, x-trace-id';

/**
 * Worker-level logger, for failures that happen outside any container.
 *
 * Separate from the per-request logger because `onError` also runs for requests
 * whose container could not be built — a missing D1 binding is precisely such a
 * case, and logging through a context that does not exist would throw again.
 *
 * `silent` is false in local development on purpose: a silent logger means a
 * 500 with an empty body is undebuggable, which is exactly what happened here
 * before this was changed. In deployed environments the platform captures
 * console output, so a second write would only double-count.
 */
const apiLogger = createLogger({
  app: 'api',
  environment: 'local',
  source: 'worker',
  release: 'dev',
  logLevel: 'INFO',
  silent: process.env.NODE_ENV === 'production',
});

/** Answer a CORS preflight, or `undefined` to let the request continue. */
const preflightFor = (request: Request, allowed: boolean): Response | undefined => {
  if (request.method !== 'OPTIONS') {
    return undefined;
  }

  const origin = request.headers.get('origin');
  if (origin === null || !allowed) {
    // No CORS headers at all. A 403 would confirm the route exists to a caller
    // that is not allowed to use it.
    return new Response(null, { status: 204 });
  }

  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      // Required for the session cookie to be sent cross-origin at all.
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': CORS_ALLOWED_HEADERS,
      'access-control-max-age': '86400',
      vary: 'Origin',
    },
  });
};

/** Add CORS headers to a real response. */
const withCors = (response: Response, origin: string | null, allowed: boolean): Response => {
  if (origin === null || !allowed) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-credentials', 'true');
  headers.set('vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
};

export const createApi = (container: Container) => {
  const trustedOrigins = parseTrustedOrigins(container.env.TRUSTED_ORIGINS);
  const originAllowed = (origin: string | null): boolean =>
    isTrustedOrigin(origin ?? '', trustedOrigins);

  return (
    new Elysia({ aot: false })
      .onError(({ error, code, request }) => {
        // Log the detail, return something the caller can act on. A stack trace
        // or an internal message in a response body is a disclosure bug.
        const traceId = request.headers.get('x-trace-id') ?? 'untraced';
        const path = new URL(request.url).pathname;

        if (code === 'VALIDATION' || code === 'NOT_FOUND') {
          // Expected outcomes. Logged at info, not error: an error log for every
          // 404 trains everyone to ignore error logs.
          apiLogger.info('request.rejected', { code, path, traceId });
        } else {
          apiLogger.error('request.failed', {
            code,
            path,
            traceId,
            message: error instanceof Error ? error.message : String(error),
          });
        }

        if (code === 'VALIDATION') {
          return Response.json(
            { error: 'validation', message: 'The request body is not valid.' },
            { status: 422 },
          );
        }
        if (code === 'NOT_FOUND') {
          return Response.json({ error: 'not_found', message: 'No such route.' }, { status: 404 });
        }

        return Response.json(
          { error: 'server_error', message: 'The request could not be completed.' },
          { status: 500 },
        );
      })

      .onRequest(({ request }) => {
        const preflight = preflightFor(request, originAllowed(request.headers.get('origin')));
        return preflight ?? undefined;
      })

      .onAfterHandle(({ request, response }) => {
        const origin = request.headers.get('origin');
        return response instanceof Response
          ? withCors(response, origin, originAllowed(origin))
          : response;
      })

      // Reports the effective (non-secret) configuration. Operators and tests
      // both need to answer "what is this deployment actually set to" without
      // reading wrangler config and guessing; it contains no secret material.
      /**
       * Liveness, plus the effective (non-secret) configuration.
       *
       * `testRunId` exists for one reason: a harness that starts a Worker on a
       * port has to be able to prove it is talking to *its* Worker. A stale
       * listener on the same port answers `/api/health` just as readily, and a
       * readiness probe that only checks for a 200 will happily run a whole suite
       * against the wrong process — passing, and proving nothing. Echoing an
       * identifier the harness supplied turns that into an actual check.
       */
      .get('/api/health', () => ({
        ok: true,
        service: 'api',
        environment: container.isLocal ? 'local' : 'production',
        authRateLimitMax: container.env.AUTH_RATE_LIMIT_MAX ?? '10 (default)',
        trustedOriginCount: trustedOrigins.length,
        ...(container.env.TEST_RUN_ID === undefined
          ? {}
          : { testRunId: container.env.TEST_RUN_ID }),
      }))

      .get('/api/whoami', async ({ request }) => {
        const { user } = await buildRequestContext(request, container);
        return user ?? unauthorized();
      })

      // Registered before the auth mount, which must stay last.
      .use(telemetryRoutes(container))
      .use(notesRoutes(container))

      /**
       * Better Auth's own fetch handler.
       *
       * MUST stay the last thing registered in this chain. Two Elysia 1.4
       * behaviours make that load-bearing, and both fail silently:
       *
       *  1. `.mount()` on a plain function **drops every route registered after
       *     it**. The app answers `/api/health` and `/api/auth/*` and 404s
       *     everything else, with no warning. Keeping the mount last means
       *     nothing follows it.
       *
       *  2. The alternative — `.all('/api/auth/*', handler, { parse: () => ({ raw: true }) })`
       *     — does compose in order, but the `parse` sentinel is not scoped to the
       *     route: it leaked to routes registered afterwards and left their
       *     request bodies unparsed, so `/api/telemetry` reported "Body is not
       *     valid JSON" for a perfectly valid payload.
       *
       * `.mount()` is therefore the lesser of two silent failure modes, and the
       * ordering is the guard. Re-verify both if Elysia is upgraded.
       */
      .mount('/api/auth', async (request: Request) => {
        try {
          return await container.auth.handler(request);
        } catch (error) {
          apiLogger.error('auth.unavailable', {
            message: error instanceof Error ? error.message : String(error),
          });
          return Response.json(
            { error: 'auth_unconfigured', message: 'Authentication is not configured.' },
            { status: 503 },
          );
        }
      })
  );
};

/**
 * The Worker entry point.
 *
 * `env` arrives as the second argument to `fetch` in workerd and is never
 * exposed on `globalThis` or `process.env` — verified on the local runtime. It
 * is passed straight into `getContainer`, which memoizes per binding set, and
 * the app is then built against that container. Nothing is stored in a module
 * variable.
 */
export const worker = {
  fetch(request: Request, env: unknown): Promise<Response> {
    return createApi(getContainer(env)).handle(request);
  },
};

export type { Container };
export default worker;
