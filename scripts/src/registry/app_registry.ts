// scripts/src/registry/app_registry.ts
//
// THE single project registry, for the tooling.
//
// It lives here rather than in `@starter/schemas` because almost none of it is a
// contract: `DEPLOYMENT_CONFIG` names Cloudflare Workers and D1 databases, and
// `APP_LOG_CONFIG` says which log adapter serves which environment. No browser
// bundle, no Worker and no request ever reads those. Shipping them from the
// portable schema package meant every frontend build carried deployment topology
// it had no use for, and it made "is this a contract or is this configuration?"
// unanswerable from the import site.
//
// What stays in `@starter/schemas` is what actually crosses a wire or a runtime
// boundary: `log_event.ts`, `note.ts`, `session.ts`, and the Tauri/CORS origin
// policy in `@starter/schemas/registry`, which the client and the API must agree
// on exactly.
//
// Three rules this file exists to enforce:
//   1. No inherited resource ids. Worker names, bucket names and D1 database ids
//      are per-user placeholders that a new project must fill in.
//   2. Capabilities are declared, not assumed. An adapter that cannot filter by
//      user id says so here, and the CLI returns `capability_unsupported`
//      instead of quietly returning everything.
//   3. Environment -> adapter mapping is explicit, so "local" can never be served
//      by a code path that needs remote credentials.

import { type Static, Type } from '@sinclair/typebox';
import type { DeploymentEnvironment } from '@starter/schemas/logging';

/** How a given app's logs are obtained in a given environment. */
export const LOG_ADAPTER_KINDS = [
  /** Structured NDJSON written to a local file by the dev processes. */
  'local-file',
  /** Historical query through the Cloudflare Workers Observability API. */
  'cloudflare-observability',
  /** Bounded live tail via `wrangler tail`. Live only, no history. */
  'wrangler-tail',
  /** Browser events forwarded to the application's own telemetry endpoint. */
  'client-forward',
] as const;

export type LogAdapterKind = (typeof LOG_ADAPTER_KINDS)[number];

/**
 * What an adapter can actually do. The CLI checks these before building a filter,
 * so an unsupported flag is a clear error and never a silent no-op.
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
  Type.Literal('cloudflare-observability'),
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
      Type.Union([Type.Literal('browser'), Type.Literal('worker'), Type.Literal('cli')]),
    ),
    /**
     * environment -> ordered adapter preference. The first entry is the one used.
     *
     * Spelled as an explicit object rather than `Type.Record` with a union key: a
     * Record over a union key collapses the value type to `never` in TypeBox v1,
     * which turns a typo in one environment's adapter list into a confusing error
     * far from its cause.
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

/**
 * One deployable environment's topology, as *configuration*.
 *
 * `origin` and `requiredSecretNames` are nonsecret by construction and belong here
 * rather than in a secret store: an origin is a public hostname, and the *names* of
 * the secrets an environment needs are the only thing a plan can print without
 * disclosing anything. What those secrets are stays a secret; that an environment
 * needs `BETTER_AUTH_SECRET` does not.
 */
const EnvironmentTopologySchema = Type.Object(
  {
    /**
     * The public origin this environment answers on, or `null` when unprovisioned.
     *
     * Required by `resolveTarget` before any deploy, because it is the only address
     * a post-deploy verification can be made against. Deriving it from the Worker
     * name is not possible: the `workers.dev` subdomain belongs to the account, not
     * to the Worker, and an operator may be serving a custom domain instead.
     */
    origin: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /**
     * Secret *names* this environment requires, in the documented apply order.
     *
     * Names only. A value here would be a plaintext secret in a tracked file, which
     * is the one thing the SOPS workflow in `docs/secrets.md` exists to prevent.
     */
    requiredSecretNames: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const DEPLOYMENT_CONFIG_SCHEMA = Type.Object(
  {
    /**
     * Project identity, and the stem every derived name uses.
     *
     * Not a secret and not a resource id: it is the name this template keeps when
     * it is renamed, and it is what ties a release record to a project rather than
     * to whichever Worker happened to answer.
     */
    projectName: Type.String({ minLength: 1 }),
    /**
     * Per-environment topology that is configuration rather than a provisioned
     * resource id. Resource ids stay out of the committed registry entirely and
     * live in the gitignored overlay — see `deployment_values.ts`.
     */
    environments: Type.Object(
      {
        staging: EnvironmentTopologySchema,
        production: EnvironmentTopologySchema,
      },
      { additionalProperties: false },
    ),
    /**
     * The Cloudflare Worker name. `null` means "not provisioned yet" — the deploy
     * dry-run reports that as an actionable error instead of inventing a target.
     *
     * One value, not one per app. The application deploys as a single Worker plus
     * its static assets, so there is exactly one name to provision; a `client` and
     * an `api` entry would be two names for one resource, and the registry's own
     * stated rule is that a value in more than one place is a value nobody can
     * tell is in effect.
     *
     * This is the *single-set* fallback, used only by a project that has never
     * declared per-environment targets. `resolveTarget` refuses rather than falling
     * back to it for a deployed environment, because a staging request answered with
     * production names is the outcome this whole layer exists to prevent.
     */
    workerName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /**
     * The D1 database id. Must be filled by the operator; never committed.
     *
     * `minLength: 1` for the same reason `workerName` has it: an empty string
     * satisfies `Type.String()` and defeats the validation that is supposed to
     * catch an unset value. `null` is how "not provisioned" is spelled.
     */
    d1DatabaseId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** Optional R2 bucket for user uploads. A documented future capability. */
    r2BucketNames: Type.Object(
      {
        uploads: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    /**
     * Custom domain. Empty by default; the starter never assumes a domain it does
     * not control, and `configure --provision` is how a user sets this.
     */
    customDomain: Type.Union([Type.String(), Type.Null()]),
    /**
     * Cloudflare account id, or `null` when unprovisioned.
     *
     * Required by every account-scoped API endpoint, including the Workers
     * Observability query the log adapter now sends. `wrangler` infers it from its
     * own auth, which is why nothing needed it until now: a historical log query
     * goes over plain HTTP, where the account is part of the URL and has to be
     * stated.
     *
     * Not an inherited resource id in the sense the others are: it identifies an
     * account rather than a resource inside one, and `null` still means "nothing
     * has been configured", so a fresh clone targets nobody.
     */
    accountId: Type.Union([Type.String(), Type.Null()]),
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
  projectName: 'starter',
  // Origins start empty on purpose. A template cannot know the account's
  // `workers.dev` subdomain, and inventing one would produce a verification step
  // that silently targets somebody else's hostname. `deploy:configure --origin`
  // writes the real value into the gitignored overlay.
  environments: {
    staging: { origin: null, requiredSecretNames: ['BETTER_AUTH_SECRET', 'RESEND_API_KEY'] },
    production: { origin: null, requiredSecretNames: ['BETTER_AUTH_SECRET', 'RESEND_API_KEY'] },
  },
  workerName: null,
  d1DatabaseId: null,
  r2BucketNames: { uploads: null },
  customDomain: null,
  accountId: null,
};

/**
 * The secrets every remote environment needs, in the order they must be applied.
 *
 * Exported rather than left inline so the plan, the preflight and the documentation
 * all name the same list. A required-secret list that exists in three places is a
 * list where one of the three is wrong.
 *
 * `MAIL_FROM` and `DEPLOYMENT_ENV` are *vars*, not secrets: they are nonsecret
 * configuration and are supplied through `wrangler.jsonc`'s environment vars, so
 * they never pass through the secret channel or a process's argv.
 */
export const REQUIRED_REMOTE_SECRET_NAMES = ['BETTER_AUTH_SECRET', 'RESEND_API_KEY'] as const;

/** Nonsecret vars every remote environment needs. Names only, never values. */
export const REQUIRED_REMOTE_VAR_NAMES = [
  'DEPLOYMENT_ENV',
  'BETTER_AUTH_URL',
  'MAIL_FROM',
  'RELEASE',
] as const;

/**
 * The apps this project deploys.
 *
 * One entry, and the name is the same one `LOG_APPS` in `@starter/schemas` uses,
 * because there is one application: one Worker serves the HTML, the assets and the
 * API. It was `['client', 'api']`, which described a deployment where the browser
 * and the API were separate resources with separate names and separate D1
 * databases — two Workers to provision for what is now one.
 *
 * The browser and the Worker are still told apart in a log, by `source`
 * (`browser` vs `worker`), not by `app`. See `@starter/schemas/logging`.
 */
export const APP_IDS = ['web'] as const;
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

const OBSERVABILITY: LogAdapterCapabilities = {
  historicalQuery: true,
  liveTail: false,
  // The Workers Observability query indexes the structured JSON payload, so a user
  // id the *server* wrote is filterable. Events the browser self-reported are not
  // treated as verified here; see `buildFilter`.
  userIdFilter: true,
  traceIdFilter: true,
  cursor: true,
};

const WRANGLER_TAIL: LogAdapterCapabilities = {
  historicalQuery: false,
  liveTail: true,
  // `wrangler tail` is a live event stream with no index, so it cannot filter
  // provider-side. A bounded client-side filter is still applied after the stream
  // is read, and docs/logs.md says which filtering happens where.
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
 * Per-app log topology. Note the asymmetry, which is deliberate and honest: the API
 * can be read historically from Cloudflare; the *browser's* logs are not server
 * logs by default and are only available where a forwarder runs.
 */
export const APP_LOG_CONFIG: Record<AppId, AppLogConfig> = {
  web: {
    app: 'web',
    workerName: null,
    // Both sources, because both halves of this application log through the same
    // deployment: the Worker's own events, and browser events it accepted at
    // `/api/telemetry` and re-emitted. There is no second Worker for browser
    // events to reach a separate provider with, which is why `client-forward` is a
    // local capability here rather than a remote one.
    sources: ['browser', 'worker', 'cli'],
    adapters: {
      // `bun run dev` writes NDJSON to `.wrangler/logs/app.ndjson` in this
      // checkout, from both the Node dev server and the telemetry endpoint.
      local: ['local-file'],
      staging: ['cloudflare-observability', 'wrangler-tail'],
      production: ['cloudflare-observability', 'wrangler-tail'],
    },
    capabilities: [LOCAL_FILE, CLIENT_FORWARD, OBSERVABILITY, WRANGLER_TAIL],
  },
};

/**
 * Per-environment resource identity.
 *
 * One set of names and ids could not describe a real deployment: a Worker is named
 * once per account, so staging and production are two Workers, and a D1 database
 * per environment. With one set, `--env staging` and `--env production` produced
 * *identical* plans, so the flag changed a notice and nothing else — the worst kind
 * of no-op, because the plan looked environment-specific and was not.
 *
 * Shape is deliberately `{ [environment]: { … } }` rather than a `Record` with an
 * optional key: an environment with no entry must not silently fall back to
 * another environment's Worker. A missing key is a refusal, and `deploy --env`
 * refuses.
 */
export interface EnvironmentTargets {
  workerName: string | null;
  d1DatabaseId: string | null;
  /**
   * Public origin for this environment, or `null`.
   *
   * Part of the target rather than a display value because it is the destination
   * verification is made against: a deploy that cannot be addressed cannot be
   * verified, and "the deploy command exited 0" is not a release record.
   */
  origin: string | null;
}

// `Partial`: presence is the signal. A project with only staging must be able to say so
// without a placeholder for production, and a placeholder is indistinguishable from a
// real name unless it is `null` — the ambiguity this layer removes.
export type PerEnvironment = Partial<Record<DeploymentEnvironment, EnvironmentTargets>>;

/**
 * Resolve the adapter kind that will serve a query, or an explicit reason.
 *
 * `follow` is what selects between the two, and getting that wrong is how
 * `bun run logs api --mode staging --follow` came to be dead in every remote
 * environment: this function returned `candidates[0]`, which for the API is
 * `cloudflare-observability`, and `tailCloudflare` then refused with "needs the
 * wrangler-tail adapter". The registry listed `wrangler-tail` in the same array
 * two entries down, so the topology said yes and the resolution said no.
 *
 * A live tail is a *different request* from a historical one, not a preference,
 * so it selects its adapter rather than taking the first:
 *
 *   - `follow`         needs an adapter with `liveTail`. `wrangler-tail` has it;
 *                      `local-file` streams; the historical one does not.
 *   - historical read  needs `historicalQuery`.
 *
 * With no request kind, the first configured adapter wins, which is what this did
 * before and is still the right answer for a bare `bun run logs web`.
 */
export const resolveLogAdapter = (
  app: AppId,
  environment: DeploymentEnvironment,
  follow = false,
): { kind: LogAdapterKind } | { unsupported: string } => {
  // A declared-`AppId` parameter makes this unreachable through the CLI, which
  // validates with `isAppId` first. It is checked anyway because this function is
  // exported and the alternative is `APP_LOG_CONFIG[app].adapters` throwing a
  // `TypeError` whose message names an index rather than the app the caller
  // typed. A refusal that says what was wrong is the difference between a fixable
  // report and a puzzle.
  const config = APP_LOG_CONFIG[app];

  if (config === undefined) {
    return {
      unsupported:
        `Unknown app "${String(app)}". This project deploys: ` +
        `${APP_IDS.map((id) => `"${id}"`).join(', ')}.`,
    };
  }

  const candidates = config.adapters[environment];

  if (candidates.length === 0) {
    return {
      unsupported:
        `No log adapter is configured for app "${app}" in environment "${environment}". ` +
        'Browser events are not server logs: they only exist in an environment where ' +
        'telemetry forwarding is enabled.',
    };
  }

  if (follow) {
    const live = candidates.find((candidate) => ADAPTER_CAPABILITIES[candidate].liveTail);
    if (live === undefined) {
      const named = candidates.map((candidate) => `"${candidate}"`).join(', ');
      return {
        unsupported:
          `No live-tail adapter is configured for app "${app}" in environment "${environment}" ` +
          `(configured: ${named}).\n` +
          '  A tail needs an adapter that streams; the historical adapters read stored events.',
      };
    }
    return { kind: live };
  }

  const historical = candidates.find(
    (candidate) => ADAPTER_CAPABILITIES[candidate].historicalQuery,
  );

  return { kind: historical ?? candidates[0] };
};

/** Every adapter kind -> its declared capabilities. */
const ADAPTER_CAPABILITIES: Record<LogAdapterKind, LogAdapterCapabilities> = {
  'local-file': LOCAL_FILE,
  'cloudflare-observability': OBSERVABILITY,
  'wrangler-tail': WRANGLER_TAIL,
  'client-forward': CLIENT_FORWARD,
};

/**
 * Capabilities of a specific adapter kind.
 *
 * The `logs` CLI consults this *before* building a filter. `wrangler-tail`
 * declaring `userIdFilter: false` is what turns `--uid` into a
 * `capability_unsupported` error rather than an unbounded event dump.
 *
 * Throws for an unrecognised kind. A `?? DEFAULT_CAPABILITIES` here would hand
 * back a permissive set for an adapter nobody described, and the CLI would then
 * build a filter the adapter cannot apply — the exact silent-no-op this table
 * exists to prevent.
 */
export const capabilitiesFor = (kind: LogAdapterKind): LogAdapterCapabilities => {
  const capabilities = ADAPTER_CAPABILITIES[kind];
  if (capabilities === undefined) {
    throw new Error(
      `Unknown log adapter kind "${String(kind)}". Declared kinds: ${LOG_ADAPTER_KINDS.join(', ')}.`,
    );
  }
  return capabilities;
};
