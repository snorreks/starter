// apps/backend/api/src/lib/request_context.ts
//
// Per-request identity, bindings and database handle.
//
// The rule this module exists to enforce: **request identity and bindings are
// explicitly scoped, never module-level mutable state.** The inherited pattern
// was a `let _env` plus `setEnvForRequest(env)` on a module singleton. It looks
// equivalent to a parameter and is not: a Worker isolate handles many concurrent
// requests, and the last caller wins for all of them. The resulting bug — a
// user occasionally reading another user's data — is rare, timing-dependent,
// and indistinguishable from an authorization bug while you are debugging it.
//
// Elysia's `resolve` runs once per request and merges its result into that
// request's handler context, so the database handle and the verified user
// travel with the request that owns them and cannot be read out of order.

import { accounts, sessions, users } from '@starter/database';
import { createBetterAuth, type BetterAuthInstance } from '@starter/auth';
import { createLogger, type ConsoleLogger } from '@starter/logger';
import { lt } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { parseTrustedOrigins } from '@starter/schemas/registry';
import type { ApiEnv } from '../env.ts';
import { resolveAuthSecret } from '../env.ts';
import { getWorkerEnv } from './worker_env.ts';

type Schema = { users: typeof users; sessions: typeof sessions; accounts: typeof accounts };

export type RequestUser = {
  id: string;
  email: string;
  name: string;
};

export type RequestContext = {
  /** Bindings for *this* request. */
  env: ApiEnv;
  /** Drizzle handle bound to this request's D1. */
  db: DrizzleD1Database<Schema>;
  /** Null for anonymous requests. Never a client-asserted value. */
  user: RequestUser | null;
  /** Correlation id: the incoming `x-trace-id`, or a generated one. */
  traceId: string;
  logger: ConsoleLogger;
  auth: BetterAuthInstance;
};

const schema: Schema = { users, sessions, accounts };

/**
 * Better Auth is expensive to construct and is stateless with respect to a
 * request, so one instance per isolate is correct. What must not be cached here
 * is anything derived from a request.
 */
let authInstance: BetterAuthInstance | undefined;

export const getAuthForRequest = (env: ApiEnv): BetterAuthInstance => {
  authInstance ??= createBetterAuth(drizzle(env.DB, { schema }), {
    baseURL: env.BETTER_AUTH_URL ?? 'http://localhost:8787',
    secret: resolveAuthSecret(
      env,
      env.BETTER_AUTH_URL !== undefined && !env.BETTER_AUTH_URL.includes('localhost'),
    ),
    trustedOrigins: parseTrustedOrigins(env.TRUSTED_ORIGINS),
  });
  return authInstance;
};

/**
 * Resolve the caller from the session cookie or the bearer token.
 *
 * Better Auth verifies the token against D1 itself. Reading a user id from a
 * request body, from a client-controlled header, or from a decoded-but-
 * unverified JWT would all be forgeable; this call is not.
 */
const resolveUser = async (env: ApiEnv, headers: Headers): Promise<RequestUser | null> => {
  const session = await getAuthForRequest(env).api.getSession({ headers });
  if (!session?.user) {
    return null;
  }
  return { id: session.user.id, email: session.user.email, name: session.user.name };
};

export const buildRequestContext = async (request: Request): Promise<RequestContext> => {
  const env = getWorkerEnv(request);
  const isLocal = env.BETTER_AUTH_URL === undefined || env.BETTER_AUTH_URL.includes('localhost');
  const traceId =
    request.headers.get('x-trace-id') ?? `tr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  return {
    env,
    db: drizzle(env.DB, { schema }),
    user: await resolveUser(env, request.headers),
    traceId,
    auth: getAuthForRequest(env),
    logger: createLogger({
      app: 'api',
      environment: isLocal ? 'local' : 'production',
      source: 'worker',
      release: env.RELEASE ?? 'dev',
      logLevel: 'INFO',
      // The platform already captures console output. A second local write
      // would double-count every line and slow the isolate down for nothing.
      silent: true,
    }),
  };
};

/**
 * Why routes call this directly instead of using an Elysia `resolve` hook.
 *
 * `resolve` was tried and removed. Two reasons, both practical:
 *
 *   1. Its type injection does not survive a context of this shape — a handler
 *      destructured `{ requestContext }` and TypeScript reported the property as
 *      absent, with no useful diagnostic. Working around it needs a cast, and a
 *      cast in the place that establishes request identity is exactly the wrong
 *      place to have one.
 *   2. Building the context at the top of each handler makes the property this
 *      module exists to guarantee *visible*: you can read that the database
 *      handle and the verified user come from the request in hand, and cannot
 *      be reached through some shared holder.
 *
 * Cost: `buildRequestContext` runs once per request either way. `getWorkerEnv`
 * memoizes on the request object, so a handler that needs it twice does not
 * rebuild it.
 */

/** 401 for an anonymous request. One place, so the shape cannot drift. */
export const unauthorized = (): Response =>
  Response.json({ error: 'unauthorized', message: 'Sign in to continue.' }, { status: 401 });

/**
 * Delete expired sessions. Exposed as a maintenance route, not on a timer.
 *
 * Counts first and returns the count: the `DELETE` result from the D1 driver
 * carries no row count, and reporting "0 rows removed" after a successful
 * delete would be a small lie in an operational log.
 */
export const purgeExpiredSessions = async (db: RequestContext['db']): Promise<number> => {
  const expired = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(lt(sessions.expiresAt, new Date()));

  if (expired.length === 0) {
    return 0;
  }

  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return expired.length;
};
