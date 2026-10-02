// apps/frontend/client/src/routes/api/auth/[...all]/+server.ts
//
// Better Auth's own handler, at the same paths the previous API served.
//
// One catch-all rather than an enumerated list of auth routes, because Better Auth
// owns that route table. Enumerating it here would be a second place to update
// every time Better Auth adds an endpoint, and the failure mode of forgetting is
// silent: the sign-in form reports "The request failed" against a Worker that is
// healthy and serving everything else.
//
// The delegation is total — every method, every path segment, the request and the
// response untouched — so the session cookie, the origin check and the response
// headers are exactly what Better Auth produced before. That is what made the
// parity claim possible: nothing here interprets the auth request.
//
// CORS is gone, and deliberately. The browser and the API are the same origin
// now, so a cross-origin credentialed request is not a case this application has
// to support. `trustedOrigins` still comes from the binding and Better Auth still
// enforces it, which is what protects a request arriving with a forged `Origin`.

import { jsonError } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

const handle: RequestHandler = async ({ request, locals }) => {
  try {
    return await locals.container.auth.handler(request);
  } catch (error) {
    // Same answer as the previous API gave: a 503 naming the condition, with the
    // detail in the log rather than in the body. A stack trace or an internal
    // message in a response is a disclosure bug.
    // The hook's own logger: the same destination every other record in this request
    // goes to. The previous code built a *second* logger here, silent in every
    // deployed environment and therefore writing nowhere — an auth outage that could
    // not be diagnosed from the logs, which is the one outage that most needs them.
    locals.context.logger.error('auth.unavailable', {
      message: error instanceof Error ? error.message : String(error),
    });
    return jsonError(503, 'auth_unconfigured', 'Authentication is not configured.');
  }
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
