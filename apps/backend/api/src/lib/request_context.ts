// apps/backend/api/src/lib/request_context.ts
//
// Per-request identity.
//
// This is the half that genuinely varies per request, and it is therefore the
// half that must never be shared. Everything here is built fresh from the
// `Request` in hand and returned; nothing is stored.
//
// The contrast with `container.ts` is the point: bindings are isolate-stable and
// live in a container; the caller's identity is not, and does not.

import { sessions } from '@starter/database';
import { createLogger, type ConsoleLogger } from '@starter/logger';
import { createId } from '@starter/utils';
import { lt } from 'drizzle-orm';
import { status } from 'elysia';
import type { Container } from './container.ts';

export type RequestUser = {
  id: string;
  email: string;
  name: string;
};

export type RequestContext = {
  /** The verified caller, or null. Never a client-asserted value. */
  user: RequestUser | null;
  traceId: string;
  logger: ConsoleLogger;
  container: Container;
};

/**
 * Resolve the caller from the session cookie or the bearer token.
 *
 * Better Auth verifies the token against D1 itself. Reading a user id from a
 * request body, from a client-controlled header, or from a decoded-but-
 * unverified JWT would all be forgeable; this call is not.
 */
const resolveUser = async (
  container: Container,
  headers: Headers,
): Promise<RequestUser | null> => {
  const session = await container.auth.api.getSession({ headers });
  if (!session?.user) {
    return null;
  }
  return { id: session.user.id, email: session.user.email, name: session.user.name };
};

export const buildRequestContext = async (
  request: Request,
  container: Container,
): Promise<RequestContext> => ({
  user: await resolveUser(container, request.headers),
  traceId: request.headers.get('x-trace-id') ?? createId('tr', 16),
  container,
  logger: createLogger({
    app: 'api',
    environment: container.isLocal ? 'local' : 'production',
    source: 'worker',
    release: container.env.RELEASE ?? 'dev',
    logLevel: 'INFO',
    // The platform captures console output. A second local write would
    // double-count every line and slow the isolate for nothing.
    silent: true,
  }),
});

/**
 * 401 for an anonymous request. One place, so the shape cannot drift.
 *
 * Uses Elysia's `status()` helper rather than a hand-built `Response`: a raw
 * Response bypasses the declared response schema, and the union Elysia then
 * infers no longer matches the 401 entry every route declares.
 */
export const unauthorized = () =>
  status(401, { error: 'unauthorized', message: 'Sign in to continue.' });

/**
 * Delete expired sessions. Exposed as a maintenance route, not on a timer.
 *
 * Counts first and returns the count: the `DELETE` result from the D1 driver
 * carries no row count, and reporting "0 rows removed" after a successful
 * delete would be a small lie in an operational log.
 */
export const purgeExpiredSessions = async (container: Container): Promise<number> => {
  const expired = await container.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(lt(sessions.expiresAt, new Date()));

  if (expired.length === 0) {
    return 0;
  }

  await container.db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return expired.length;
};
