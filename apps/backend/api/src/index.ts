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
// CORS is implemented inline rather than with `@elysiajs/cors` for one reason:
// the trusted-origin allowlist comes from a Worker variable, and a plugin's
// static config is evaluated before any request exists. Thirty readable lines
// that can read the request's own env beat a plugin that cannot.

import { createLogger } from '@starter/logger';
import { isTrustedOrigin, parseTrustedOrigins } from '@starter/schemas/registry';
import { Elysia } from 'elysia';
import { getWorkerEnv } from './lib/worker_env.ts';
import { notesRoutes } from './lib/notes.ts';
import { telemetryRoutes } from './lib/telemetry.ts';
import { buildRequestContext, getAuthForRequest } from './lib/request_context.ts';

const CORS_ALLOWED_HEADERS = 'content-type, authorization, x-trace-id';

/**
 * Worker-level logger.
 *
 * Separate from the per-request logger in `requestContext` because `onError`
 * runs for requests whose context never resolved — a failure to read the D1
 * binding, a bad origin. Using the per-request logger there would mean logging
 * through a context that does not exist.
 */
const apiLogger = createLogger({
  app: 'api',
  environment: 'local',
  source: 'worker',
  release: 'dev',
  logLevel: 'INFO',
  // The platform captures console output; a second write double-counts it.
  silent: true,
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

/**
 * Trusted origins, tolerating a missing D1 binding.
 *
 * A request can fail before the binding exists (a misconfigured Worker, a harness
 * without bindings). Rejecting the origin there is the safe answer, and it must
 * not throw a second, less useful error on top of the first.
 */
const tryTrustedOrigins = (request: Request): string[] => {
  try {
    return parseTrustedOrigins(getWorkerEnv(request).TRUSTED_ORIGINS);
  } catch {
    return [];
  }
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

export const createApi = () =>
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

    .onRequest(async ({ request }) => {
      // Read the binding directly rather than through a resolved context: this
      // hook also runs for requests that never reach a route, including ones
      // that fail precisely because the binding is missing.
      const allowed = isTrustedOrigin(
        request.headers.get('origin') ?? '',
        tryTrustedOrigins(request),
      );
      const preflight = preflightFor(request, allowed);
      if (preflight) {
        return preflight;
      }
      return undefined;
    })

    .onAfterHandle(({ request, response }) => {
      const origin = request.headers.get('origin');
      const allowed = isTrustedOrigin(origin ?? '', tryTrustedOrigins(request));
      // `onAfterHandle` sees whatever the handler returned, which may not be a
      // Response (Elysia also allows a plain object it will serialise later).
      return response instanceof Response ? withCors(response, origin, allowed) : response;
    })

    .get('/api/health', () => ({ ok: true, service: 'api' }))

    .get('/api/whoami', async ({ request }) => {
      const { user } = await buildRequestContext(request);
      return (
        user ??
        Response.json({ error: 'unauthorized', message: 'Sign in to continue.' }, { status: 401 })
      );
    })

    /**
     * Better Auth's own fetch handler.
     *
     * Mounted as a raw `Request -> Response` handler so it receives the body
     * untouched: Elysia's JSON body parser would otherwise consume the stream
     * first and Better Auth would see an empty body on every sign-in.
     *
     * It reads its own bindings from the request, because a mounted fetch
     * handler is not a route handler and does not receive a resolved context.
     */
    .mount('/api/auth', async (request: Request) => {
      try {
        return getAuthForRequest(getWorkerEnv(request)).handler(request);
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

    .use(telemetryRoutes())
    .use(notesRoutes());

export const api = createApi();
export default api;
