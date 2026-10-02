// apps/frontend/client/src/lib/server/request_context.ts
//
// Per-request identity.
//
// This is the half that genuinely varies per request, and it is therefore the
// half that must never be shared. Everything here is built fresh from the
// `Request` in hand and returned; nothing is stored.
//
// The contrast with `container.ts` is the point: bindings are isolate-stable and
// live in a container; the caller's identity is not, and does not. `event.locals`
// is the only place a request's identity lives, and `locals` is discarded when
// the request ends.

import { sessions } from '@starter/database';
import { type ConsoleLogger, createLogger, type LogContext, toLogEvent } from '@starter/logger';
import type { LogEntry, LogSink } from '@starter/schemas/logging';
import { createId } from '@starter/utils';
import { lt } from 'drizzle-orm';
import type { Container } from './container.ts';
import { unauthorized } from './http.ts';

/**
 * The verified caller, as page data.
 *
 * Structurally `SessionUser` from `@starter/schemas` — the DTO the browser's
 * `SessionService` already expects — but built here from the Better Auth session
 * rather than handed through. The mapping is the point: Better Auth's user object
 * carries `image` and its session object carries a token, and a page load that
 * returned any of those would be publishing a session credential into the HTML.
 * Naming the fields is what makes that impossible to do by accident.
 */
export interface RequestUser {
  id: string;
  email: string;
  displayName: string;
  provider: 'email';
  /**
   * Whether this address has been confirmed.
   *
   * Carried explicitly because a session and a verified address are different
   * facts. Deriving "verified" from "has a session" would tell every user who
   * signed up before verification was enabled that they are verified, which is a
   * claim this application cannot actually support.
   */
  emailVerified: boolean;
}

export interface RequestContext {
  /** The verified caller, or null. Never a client-asserted value. */
  user: RequestUser | null;
  traceId: string;
  logger: ConsoleLogger;
  container: Container;
}

/**
 * True when this request is being served by the Node dev/preview server.
 *
 * `vite dev` and `vite preview` run the same SvelteKit server code in Node rather
 * than in workerd, and Node has no platform console capture: whatever the logger
 * writes *is* the whole record. Read through `globalThis` so the check is safe to
 * evaluate in the Worker bundle, where `process` does not exist.
 */
const IS_NODE_RUNTIME =
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node ===
  'string';

/**
 * A sink that writes one NDJSON line per event on stdout.
 *
 * Needed because in Node there is no platform log capture, and because
 * `ConsoleLogger`'s own output is `%c`-formatted for a human. The dev launcher
 * (`bun run dev`) redirects stdout into `.wrangler/logs/app.ndjson`, which is
 * what `bun run logs --mode local` reads; without this the file would contain
 * banners and nothing parseable, and a working log CLI would report no events.
 *
 * It is a sink rather than a direct write so it reuses the logger's own
 * redaction and normalization instead of serializing a raw entry.
 *
 * It is a factory rather than a constant because `toLogEvent` needs the log
 * context, and a sink only receives the entry. Capturing the context here is what
 * makes the emitted line carry `app`/`environment`/`release` — which is how
 * `bun run logs web --mode local` filters a stream where browser-forwarded and
 * server-originated records are told apart by exactly those fields.
 */
const ndjsonStdoutSink = (context: LogContext): LogSink => ({
  name: 'ndjson-stdout',
  write(entry: LogEntry) {
    const stdout = (globalThis as { process?: { stdout?: { write?: (chunk: string) => unknown } } })
      .process?.stdout;
    stdout?.write?.(`${JSON.stringify(toLogEvent(entry, context))}\n`);
  },
});

/**
 * Resolve the caller from the session cookie or the bearer token.
 *
 * Better Auth verifies the token against D1 itself. Reading a user id from a
 * request body, from a client-controlled header, or from a decoded-but-
 * unverified JWT would all be forgeable; this call is not.
 */
export const resolveUser = async (
  container: Container,
  headers: Headers,
): Promise<RequestUser | null> => {
  const session = await container.auth.api.getSession({ headers });
  if (!session?.user) {
    return null;
  }
  // `provider: 'email'` is a literal, not a value read from anywhere. Only email
  // and password is enabled, and a cast to a wider provider would publish a claim
  // this application cannot honour.
  return {
    id: session.user.id,
    email: session.user.email,
    displayName: session.user.name,
    provider: 'email',
    emailVerified: session.user.emailVerified,
  };
};

export const buildRequestContext = async (
  request: Request,
  container: Container,
): Promise<RequestContext> => {
  // One context object, used for both the logger and the sink. Two literals would
  // be two places to forget `release`, and a line with the wrong release is a log
  // that cannot be tied to a revision — which is the question the field exists to
  // answer.
  const context: LogContext = {
    app: 'web',
    environment: container.isLocal ? 'local' : 'production',
    source: 'worker',
    release: container.env.RELEASE ?? 'dev',
  };

  const logger = createLogger({
    ...context,
    logLevel: 'INFO',
    // The platform captures console output in a deployed Worker, so a second
    // write there would only double-count every line.
    silent: !IS_NODE_RUNTIME,
    ...(IS_NODE_RUNTIME ? { sinks: [ndjsonStdoutSink(context)] } : {}),
  });

  return {
    user: await resolveUser(container, request.headers),
    traceId: request.headers.get('x-trace-id') ?? createId('tr', 16),
    container,
    logger,
  };
};

export { unauthorized };

/**
 * Delete expired sessions. Exposed as a maintenance operation, not on a timer.
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
