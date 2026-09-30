// packages/shared/schemas/src/registry/app_registry.ts
//
// THE single project registry.
//
// Deployment tooling, the `logs` CLI and the Pi log wrapper all read this file.
// Nothing else is allowed to hold its own app -> worker / app -> bucket map;
// a duplicated map is how a staging query silently hits production.
//
// Three rules this file exists to enforce:
//   1. No inherited resource ids. Worker names, bucket names and D1 database
//      ids are *per-user placeholders* that a new project must fill in.
//   2. Capabilities are declared, not assumed. An adapter that cannot filter by
//      user id says so here, and the CLI returns `capability_unsupported`
//      instead of quietly returning everything.
//   3. Environment -> adapter mapping is explicit, so "local" can never be
//      served by a Cloudflare code path that needs credentials.

import { type Static, Type } from '@sinclair/typebox';
import type { DeploymentEnvironment } from '../logging/log_event.ts';

/** How a given app's logs are obtained in a given environment. */
export const LOG_ADAPTER_KINDS = [
  /** Structured NDJSON written to a local file by the dev processes. */
  'local-file',
  /** Cloudflare Logpush historical query via the provider's query API. */
  'cloudflare-logpush',
  /** Bounded live tail via `wrangler tail`. Live only, no history. */
  'wrangler-tail',
  /** Browser/native events forwarded to the API's telemetry endpoint. */
  'client-forward',
] as const;

export type LogAdapterKind = (typeof LOG_ADAPTER_KINDS)[number];

/**
 * What an adapter can actually do. The CLI checks these before building a
 * filter, so an unsupported flag is a clear error and never a silent no-op.
 */
export const LogAdapterCapabilitiesSchema = Type.Object(
  {
    historicalQuery: Type.Boolean(),
    liveTail: Type.Boolean(),
    /** Can the provider filter by verified user id (not client-reported)? */
    userIdFilter: Type.Boolean(),
    traceIdFilter: Type.Boolean(),
    /** Provider returns a resumable cursor. */
    cursor: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type LogAdapterCapabilities = Static<typeof LogAdapterCapabilitiesSchema>;

/** One adapter kind. Written out so TypeBox receives a real tuple. */
const AdapterKindSchema = Type.Union([
  Type.Literal('local-file'),
  Type.Literal('cloudflare-logpush'),
  Type.Literal('wrangler-tail'),
  Type.Literal('client-forward'),
]);

/** Ordered adapter preference for one environment. */
const adapterListSchema = Type.Array(AdapterKindSchema);

export const AppLogConfigSchema = Type.Object(
  {
    app: Type.String({ minLength: 1 }),
    /**
     * Wrangler worker name for this app. `null` means "not provisioned yet".
     *
     * Nullable rather than `''` on purpose: an empty string satisfies a
     * `minLength: 1` check by not being one, so a `''` placeholder silently
     * defeats the validation that was supposed to catch it — the registry shipped
     * failing its own schema until this was fixed. `DEPLOYMENT_CONFIG` uses the
     * same convention, so "not provisioned" reads the same everywhere.
     */
    workerName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** Which producer sources can appear for this app. */
    sources: Type.Array(
      Type.Union([
        Type.Literal('browser'),
        Type.Literal('worker'),
        Type.Literal('native'),
        Type.Literal('cli'),
      ]),
    ),
    /**
     * environment -> ordered adapter preference. The first entry is the one used.
     *
     * Spelled as an explicit object rather than `Type.Record` with a union key:
     * a Record over a union key collapses the value type to `never` in TypeBox
     * v1, which turns a typo in one environment's adapter list into a confusing
     * error far from its cause.
     */
    adapters: Type.Object(
      {
        local: adapterListSchema,
        staging: adapterListSchema,
        production: adapterListSchema,
      },
      { additionalProperties: false },
    ),
    capabilities: Type.Array(LogAdapterCapabilitiesSchema),
  },
  { additionalProperties: false },
);

export type AppLogConfig = Static<typeof AppLogConfigSchema>;

export const DEPLOYMENT_CONFIG_SCHEMA = Type.Object(
  {
    /**
     * Cloudflare Worker names. `null` means "not provisioned yet" — the deploy
     * dry-run reports that as an actionable error instead of inventing a target.
     */
    workerNames: Type.Object(
      {
        client: Type.Union([Type.String(), Type.Null()]),
        api: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    /** D1 database ids. Must be filled by the operator; never committed. */
    d1DatabaseIds: Type.Object(
      {
        api: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    /** Optional R2 bucket for user uploads. Round 1: optional capability. */
    r2BucketNames: Type.Object(
      {
        uploads: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    /**
     * Custom domains. Empty by default; the starter never assumes a domain it
     * does not control, and `deploy:configure` is how a user sets these.
     */
    customDomains: Type.Object(
      {
        client: Type.Union([Type.String(), Type.Null()]),
        api: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type DeploymentConfig = Static<typeof DEPLOYMENT_CONFIG_SCHEMA>;

/**
 * Placeholder project identity. Every value here is intentionally empty or
 * obviously generic: a fresh clone has provisioned nothing yet, and the tooling
 * must say so rather than reaching for a previous project's resources.
 */
export const DEPLOYMENT_CONFIG: DeploymentConfig = {
  workerNames: { client: null, api: null },
  d1DatabaseIds: { api: null },
  r2BucketNames: { uploads: null },
  customDomains: { client: null, api: null },
};

/** Apps that exist in this project. Used for CLI validation and docs. */
export const APP_IDS = ['client', 'api'] as const;
export type AppId = (typeof APP_IDS)[number];

export const isAppId = (value: unknown): value is AppId =>
  typeof value === 'string' && (APP_IDS as readonly string[]).includes(value);

const LOCAL_FILE: LogAdapterCapabilities = {
  historicalQuery: true,
  liveTail: true,
  userIdFilter: true,
  traceIdFilter: true,
  cursor: false,
};

const LOGPUSH: LogAdapterCapabilities = {
  historicalQuery: true,
  liveTail: false,
  // Cloudflare Logpush indexes the structured JSON payload, so a user id that
  // the *server* wrote is filterable. Events the browser self-reported are not
  // treated as verified here; see `resolveUserFilter` in the logs adapter.
  userIdFilter: true,
  traceIdFilter: true,
  cursor: true,
};

const WRANGLER_TAIL: LogAdapterCapabilities = {
  historicalQuery: false,
  liveTail: true,
  // `wrangler tail` is a live event stream with no index: it cannot filter.
  userIdFilter: false,
  traceIdFilter: false,
  cursor: false,
};

const CLIENT_FORWARD: LogAdapterCapabilities = {
  historicalQuery: false,
  liveTail: false,
  // These arrive as server records, so the server can filter on the *stored*
  // value; but there is no provider-side index, so it is only usable locally.
  userIdFilter: true,
  traceIdFilter: true,
  cursor: false,
};

/**
 * Per-app log topology. Note the asymmetry, which is deliberate and honest:
 * the API can be read historically from Cloudflare; the *browser*'s logs are
 * not server logs by default and are only available where a forwarder runs.
 */
export const APP_LOG_CONFIG: Record<AppId, AppLogConfig> = {
  client: {
    app: 'client',
    workerName: null,
    sources: ['browser', 'native'],
    adapters: {
      // In dev the browser writes NDJSON through the Vite logging middleware.
      local: ['local-file'],
      // Browser events reach the provider only if client telemetry forwarding
      // is enabled for the deployment, which round 1 does not enable.
      staging: [],
      production: [],
    },
    capabilities: [LOCAL_FILE, CLIENT_FORWARD],
  },
  api: {
    app: 'api',
    workerName: null,
    sources: ['worker'],
    adapters: {
      local: ['local-file'],
      staging: ['cloudflare-logpush', 'wrangler-tail'],
      production: ['cloudflare-logpush', 'wrangler-tail'],
    },
    capabilities: [LOCAL_FILE, LOGPUSH, WRANGLER_TAIL],
  },
};

/** Resolve the adapter kind that will serve a query, or an explicit reason. */
export const resolveLogAdapter = (
  app: AppId,
  environment: DeploymentEnvironment,
): { kind: LogAdapterKind } | { unsupported: string } => {
  const candidates = APP_LOG_CONFIG[app].adapters[environment];
  const kind = candidates[0];

  if (!kind) {
    return {
      unsupported:
        `No log adapter is configured for app "${app}" in environment "${environment}". ` +
        `Browser and native events are not server logs: they only exist in an ` +
        `environment where client telemetry forwarding is enabled.`,
    };
  }

  return { kind };
};

/** Every adapter kind -> its declared capabilities. */
const ADAPTER_CAPABILITIES = {
  'local-file': LOCAL_FILE,
  'cloudflare-logpush': LOGPUSH,
  'wrangler-tail': WRANGLER_TAIL,
  'client-forward': CLIENT_FORWARD,
} as const satisfies Record<LogAdapterKind, LogAdapterCapabilities>;

/**
 * Capabilities of a specific adapter kind.
 *
 * The `logs` CLI consults this *before* building a filter. `wrangler-tail`
 * declaring `userIdFilter: false` is what turns `--uid` into a
 * `capability_unsupported` error rather than an unbounded event dump.
 */
export const capabilitiesFor = (kind: LogAdapterKind): LogAdapterCapabilities =>
  ADAPTER_CAPABILITIES[kind];
