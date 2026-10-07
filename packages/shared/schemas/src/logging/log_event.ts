// packages/shared/schemas/src/logging/log_event.ts
//
// The one structured event shape used by every producer (browser, Worker) and
// every consumer (console, `bun run logs`, Pi log tool). Keeping a
// single schema here is what makes cross-plane correlation possible: a browser
// event and a Worker event are queryable with the same field names.
//
// Note on style: each union is written out as an explicit `v.union([...])`
// rather than built with `.map()` over a const array. Valibot's `picklist`
// takes a *tuple*, so a mapped array collapses its static type to `never` —
// which surfaces as a confusing "type X is not assignable to never" far from the
// real mistake. The runtime arrays below stay the source of truth for
// iteration, and `_appUnionIsSynced`/`_levelUnionIsSynced` make the compiler
// enforce that the two never drift.

import * as v from 'valibot';

// -----------------------------------------------------------------------------
// Severity
// -----------------------------------------------------------------------------

export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'NONE'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LogLevelPriority = {
  DEBUG: 1,
  INFO: 2,
  WARNING: 3,
  ERROR: 4,
  NONE: 5,
} as const satisfies Record<LogLevel, number>;

/**
 * Widen the literal-keyed priority map to a `Record<LogLevel, …>`.
 * Indexing the literal directly with a `LogLevel`-typed variable is an error.
 */
export const LogLevelIndex: Record<LogLevel, LogLevel> = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  NONE: 'NONE',
};

export const isLogLevel = (value: unknown): value is LogLevel =>
  typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);

// -----------------------------------------------------------------------------
// Event vocabulary
// -----------------------------------------------------------------------------

/**
 * Which application emitted the event. Mirrors the app registry.
 *
 * `web` is the single full-stack application: its server half runs in workerd and
 * its browser half runs in the page, and both emit under this name. Which half
 * produced a record is `source`, not `app` — that is the distinction the field
 * below exists to keep, and it is why a browser event forwarded through the
 * server is still `source: 'browser'`.
 *
 * The vocabulary used to be `client` + `api` + `native`, which described a split
 * deployment. Keeping those names after the split ended would have meant every
 * log line claiming to come from an application that no longer exists.
 */
export const LOG_APPS = ['web', 'scripts'] as const;
export type LogApp = (typeof LOG_APPS)[number];

/**
 * Where the event physically originated. Deliberately distinct from `app`: a
 * Worker reading a browser-forwarded event is still reporting `source=browser`.
 */
export const LOG_SOURCES = ['browser', 'worker', 'cli'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

export const DEPLOYMENT_ENVIRONMENTS = ['local', 'staging', 'production'] as const;
export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

export const isDeploymentEnvironment = (value: unknown): value is DeploymentEnvironment =>
  typeof value === 'string' && (DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(value);

/**
 * Cloudflare's Logpush / `wrangler tail` severity vocabulary. Kept as a union
 * rather than `string` so a typo in a filter is a type error rather than a
 * silently empty query.
 */
export const PROVIDER_LEVELS = [
  'DEBUG',
  'INFO',
  'NOTICE',
  'WARNING',
  'ERROR',
  'CRITICAL',
  'ALERT',
  'EMERGENCY',
] as const;
export type ProviderLevel = (typeof PROVIDER_LEVELS)[number];

/** Project level -> lowest provider severity still reported. */
export const LEVEL_TO_PROVIDER_SEVERITY = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  NONE: 'EMERGENCY',
} as const satisfies Record<LogLevel, ProviderLevel>;

/** The lowest provider severity that satisfies a project log level. */
export const PROVIDER_SEVERITY_RANK: Record<ProviderLevel, number> = {
  DEBUG: 1,
  INFO: 2,
  NOTICE: 3,
  WARNING: 4,
  ERROR: 5,
  CRITICAL: 6,
  ALERT: 7,
  EMERGENCY: 8,
};

// -----------------------------------------------------------------------------
// The event schema
// -----------------------------------------------------------------------------

export const LogEventSchema = v.strictObject({
  /** Epoch milliseconds. Assigned at capture time, not at render time. */
  timestamp: v.pipe(v.number(), v.finite()),
  app: v.union([v.literal('web'), v.literal('scripts')]),
  environment: v.union([v.literal('local'), v.literal('staging'), v.literal('production')]),
  source: v.union([v.literal('browser'), v.literal('worker'), v.literal('cli')]),
  level: v.union([
    v.literal('DEBUG'),
    v.literal('INFO'),
    v.literal('WARNING'),
    v.literal('ERROR'),
    v.literal('NONE'),
  ]),
  /** Stable machine-readable name, e.g. `notes.create`. */
  event: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  /** Build identifier of the emitting artifact; the pivot for "which code?". */
  release: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  /** Correlates a request across planes (Worker request id, fetch trace id). */
  traceId: v.optional(v.pipe(v.string(), v.maxLength(200))),
  requestId: v.optional(v.pipe(v.string(), v.maxLength(200))),
  /**
   * User id. On browser-forwarded events this is *client reported* and is sent
   * under `clientReported` instead — see {@link TelemetryPayload}. The server
   * never treats a self-asserted id as verified.
   */
  userId: v.optional(v.pipe(v.string(), v.maxLength(200))),
  sessionId: v.optional(v.pipe(v.string(), v.maxLength(200))),
  message: v.optional(v.pipe(v.string(), v.maxLength(4000))),
  /** Free-form, already redacted, size-bounded by the producer. */
  data: v.optional(v.record(v.string(), v.unknown())),
});

export type LogEvent = v.InferOutput<typeof LogEventSchema>;

// -----------------------------------------------------------------------------
// Compile-time sync guards
//
// These are assertions, not runtime checks: if someone adds a value to a const
// array above without adding it to the schema (or vice versa), the build fails
// here with a pointed error. This is what keeps the duplication above honest
// without resorting to a cast.
// -----------------------------------------------------------------------------

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _levelUnionIsSynced: Exact<LogLevel, v.InferOutput<typeof LogEventSchema>['level']> = true;
const _appUnionIsSynced: Exact<LogApp, v.InferOutput<typeof LogEventSchema>['app']> = true;
const _sourceUnionIsSynced: Exact<LogSource, v.InferOutput<typeof LogEventSchema>['source']> = true;
const _environmentUnionIsSynced: Exact<
  DeploymentEnvironment,
  v.InferOutput<typeof LogEventSchema>['environment']
> = true;

/** Referenced so the guards are not flagged as unused. */
export const SCHEMA_UNION_ASSERTIONS = [
  _levelUnionIsSynced,
  _appUnionIsSynced,
  _sourceUnionIsSynced,
  _environmentUnionIsSynced,
] as const;

// -----------------------------------------------------------------------------
// Client-reported context
// -----------------------------------------------------------------------------

/**
 * Context a browser client asserts about itself.
 *
 * Sent as its own object so a server-side reader can never mistake a
 * self-reported identity for a verified one: `LogEvent.userId` is filled in by
 * the server from the session, and anything the client claims lands here.
 */
export const ClientReportedContextSchema = v.strictObject({
  userId: v.optional(v.pipe(v.string(), v.maxLength(200))),
  sessionId: v.optional(v.pipe(v.string(), v.maxLength(200))),
  appVersion: v.optional(v.pipe(v.string(), v.maxLength(100))),
  platform: v.optional(v.pipe(v.string(), v.maxLength(100))),
  userAgent: v.optional(v.pipe(v.string(), v.maxLength(400))),
});

export type ClientReportedContext = v.InferOutput<typeof ClientReportedContextSchema>;
