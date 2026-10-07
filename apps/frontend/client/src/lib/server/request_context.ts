// apps/frontend/client/src/lib/server/request_context.ts
//
// Per-request identity, and the one destination its records go to.
//
// This is the half that genuinely varies per request, and it is therefore the half
// that must never be shared. Everything here is built fresh from the `Request` in
// hand and returned; nothing is stored.
//
// The contrast with `container.ts` is the point: bindings are isolate-stable and
// live in a container; the caller's identity is not, and does not. `event.locals`
// is the only place a request's identity lives, and `locals` is discarded when the
// request ends. A route that needs a trace id reads `locals.context`, which the
// hook already built — it does not resolve the session a second time.

import type { VerifiedIdentity } from '@starter/auth/supabase';
import { users } from '@starter/database';
import {
  type ConsoleLogger,
  createLogger,
  createNdjsonStdoutEmitter,
  createStructuredConsoleEmitter,
  type LogContext,
  type StructuredEmitter,
} from '@starter/logger';
import { type DeploymentEnvironment, isDeploymentEnvironment } from '@starter/schemas/logging';
import { createId } from '@starter/utils';
import { eq } from 'drizzle-orm';
import type { Container } from './container.ts';
import { unauthorized } from './http.ts';
import type { ApplicationServices } from './supabase_context.ts';

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
  /**
   * This server's trace id for this request. Generated here, never taken from a
   * header — see `boundCorrelationLabel` and `clientTraceId`.
   */
  traceId: string;
  /**
   * The provider's id for this request, when the runtime gives us one and it is
   * well formed. This is what ties the record to the provider's own logs.
   */
  requestId: string | null;
  /**
   * A correlation label the *client* chose, bounded and validated, or null.
   *
   * Kept because it is genuinely useful in a support conversation, and kept out of
   * `traceId` because it is forgeable: a caller that could choose the trace id
   * could place its records inside another request's history.
   */
  clientTraceId: string | null;
  logger: ConsoleLogger;
  /** The single structured destination this request's records are written to. */
  emitter: StructuredEmitter;
  container: Container;
  backendProfile: 'legacy' | 'supabase';
  identity: VerifiedIdentity | null;
  services: ApplicationServices | null;
  responseHeaders: Headers | null;
}

/**
 * Which runtime is serving, because the two have different destinations.
 *
 *   * `workerd` — one JSON object per record through `console`, which is what
 *     `wrangler tail`, Workers Logs and Logpush index. There is no stdout here and
 *     nothing else to redirect, which is exactly why this was broken: the old code
 *     built a silent logger with no sink and dropped every record.
 *   * `node` — one NDJSON line on stdout, which `bun run dev` redirects into
 *     `.wrangler/logs/app.ndjson` and `bun run logs web --mode local` reads.
 */
export type LogRuntime = 'node' | 'workerd';

/**
 * The runtime this bundle is executing in.
 *
 * Read through `globalThis` so evaluating it inside the Worker bundle is safe: in
 * workerd `process` does not exist, and a bare `process` reference would throw at
 * import time rather than being false.
 */
export const detectLogRuntime = (): LogRuntime =>
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node ===
  'string'
    ? 'node'
    : 'workerd';

/**
 * The container's validated environment, as the log vocabulary spells it.
 *
 * `AppEnv.DEPLOYMENT_ENV` admits one internal name the log schema does not, so this
 * is the single place that mapping happens. A log field that reported a name no log
 * query can filter on would be worse than one that reported the container's.
 */
export const toLogEnvironment = (container: Container): DeploymentEnvironment => {
  const environment = container.environment;
  if (isDeploymentEnvironment(environment)) {
    return environment;
  }
  // Unreachable through `getContainer`, which validates before it returns a
  // container. Reachable only if a caller constructs one by hand — and a record
  // that named an unknown environment would be a lie an operator could not correct
  // by filtering, so it falls back to the coarse truth.
  return container.isLocal ? 'local' : 'production';
};

/**
 * The structured destination for server records in one runtime.
 *
 * Exported separately from the context so a server log created outside a request —
 * the startup logger, the auth-failure logger — reaches the same place instead of
 * inventing a third convention.
 */
export const serverEmitter = (
  context: LogContext,
  runtime: LogRuntime = detectLogRuntime(),
  options: { traceId?: string } = {},
): StructuredEmitter =>
  runtime === 'node'
    ? createNdjsonStdoutEmitter(context, options)
    : createStructuredConsoleEmitter(context, options);

/**
 * A logger that renders nothing itself and emits exactly one structured record
 * through one emitter.
 *
 * `silent: true` plus a sink, deliberately. Two renders would mean two records for
 * one event — a duplicate in the platform's log index and a double count in a
 * local NDJSON file — and `createLogger` now refuses the silent-with-no-sink
 * combination outright, because that is the shape that lost every record in workerd.
 */
export const createServerRecordLogger = (
  context: LogContext,
  runtime: LogRuntime = detectLogRuntime(),
  options: { traceId?: string } = {},
): { logger: ConsoleLogger; emitter: StructuredEmitter } => {
  const emitter = serverEmitter(context, runtime, options);
  return {
    emitter,
    logger: createLogger({ ...context, logLevel: 'INFO', silent: true, sinks: [emitter] }),
  };
};

/**
 * The server's own view of where it is running.
 *
 * `container.environment`, which `getContainer` has already validated. The previous
 * `isLocal ? 'local' : 'production'` labelled staging as production, so a staging
 * incident could not be found by filtering on the field whose whole purpose is to
 * name the environment.
 */
export const resolveLogContext = (container: Container): LogContext => ({
  app: 'web',
  environment: toLogEnvironment(container),
  source: 'worker',
  release: container.env.RELEASE ?? 'dev',
});

/** Long enough for a provider id, short enough that a header cannot be a payload. */
const MAX_LABEL_LENGTH = 200;

/**
 * Bound an incoming correlation label, or refuse it.
 *
 * Two bounds, both needed. Length is the obvious one. The character set is the one
 * that matters for a log: an unfiltered header value copied into a structured field
 * is how a caller gets newlines and terminal escapes into an operator's log viewer,
 * and how a five kilobyte header becomes a five kilobyte record.
 */
export const boundCorrelationLabel = (raw: string | null): string | null => {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) {
    return null;
  }
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
};

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

/**
 * Resolve the explicitly seeded emulator identity from D1. The fixture itself is
 * owned by the launcher; the application reads the user record through its normal
 * database binding just like it reads notes.
 */
const emulatorUserFor = async (
  container: Container,
  runtime: LogRuntime,
): Promise<RequestUser | null> => {
  const nodeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  const userId = nodeProcess?.env?.STARTER_EMULATOR_USER_ID;
  const bindHost = nodeProcess?.env?.DEV_HOST ?? '127.0.0.1';
  if (
    runtime !== 'node' ||
    !container.isLocal ||
    !new Set(['127.0.0.1', 'localhost', '::1', '[::1]']).has(bindHost) ||
    nodeProcess?.env?.STARTER_EMULATOR_MOCKS !== 'true' ||
    userId === undefined ||
    userId.length === 0
  ) {
    return null;
  }

  const user = await container.db.query.users.findFirst({ where: eq(users.id, userId) });
  return user === undefined
    ? null
    : {
        id: user.id,
        email: user.email,
        displayName: user.name,
        provider: 'email',
        emailVerified: user.emailVerified,
      };
};

/**
 * Build the context for one request.
 *
 * `container` comes first because it is the authority: the environment, the
 * release and the session verifier all come from it, and passing the request last
 * keeps "what is this request running against" reading in the same order.
 *
 * `options.runtime` exists so a unit test can exercise both destinations. Detection
 * itself is proved against the built Worker in `tests/worker_integration.test.ts`,
 * where nothing is injected.
 */
export const buildRequestContext = async (
  container: Container,
  request: Request,
  options: {
    runtime?: LogRuntime;
    identity?: VerifiedIdentity | null;
    services?: ApplicationServices | null;
    responseHeaders?: Headers | null;
  } = {},
): Promise<RequestContext> => {
  const context = resolveLogContext(container);
  const traceId = createId('tr', 16);
  // The trace id is generated before the logger is built and handed to it, so every
  // record this context emits is correlated by construction rather than by a call
  // site remembering to pass it.
  const { logger, emitter } = createServerRecordLogger(context, options.runtime, { traceId });

  const runtime = options.runtime ?? detectLogRuntime();
  const user = await resolveRequestUser(container, request, runtime, options);
  return {
    user,
    traceId,
    requestId: boundCorrelationLabel(request.headers.get('cf-ray')),
    clientTraceId: boundCorrelationLabel(request.headers.get('x-trace-id')),
    container,
    backendProfile: container.backendProfile,
    identity: options.identity ?? null,
    services: options.services ?? null,
    responseHeaders: options.responseHeaders ?? null,
    logger,
    emitter,
  };
};

const resolveRequestUser = async (
  container: Container,
  request: Request,
  runtime: LogRuntime,
  options: { identity?: VerifiedIdentity | null },
): Promise<RequestContext['user']> => {
  if (Object.hasOwn(options, 'identity')) {
    if (options.identity) {
      return { ...options.identity.user, provider: 'email' };
    }
    return null;
  }
  return (
    (await emulatorUserFor(container, runtime)) ?? (await resolveUser(container, request.headers))
  );
};

export { unauthorized };
