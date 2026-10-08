// scripts/src/registry/app_registry.ts
//
// THE single project registry, for the tooling.
//
// It lives here rather than in `@starter/schemas` because almost none of it is a
// contract: `DEPLOYMENT_CONFIG` names Cloudflare Workers, and
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
//   1. No inherited resource ids. Worker names and bucket names
//      are per-user placeholders that a new project must fill in.
//   2. Capabilities are declared, not assumed. An adapter that cannot filter by
//      user id says so here, and the CLI returns `capability_unsupported`
//      instead of quietly returning everything.
//   3. Environment -> adapter mapping is explicit, so "local" can never be served
//      by a code path that needs remote credentials.

import type { DeploymentEnvironment } from '@starter/schemas/logging';
import * as v from 'valibot';

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
export const LogAdapterCapabilitiesSchema = v.strictObject({
  historicalQuery: v.boolean(),
  liveTail: v.boolean(),
  /** Can the provider filter by verified user id (not client-reported)? */
  userIdFilter: v.boolean(),
  traceIdFilter: v.boolean(),
  /** Provider returns a resumable cursor. */
  cursor: v.boolean(),
});

export type LogAdapterCapabilities = v.InferOutput<typeof LogAdapterCapabilitiesSchema>;

/** One adapter kind. Written out so the validator receives a literal tuple. */
const AdapterKindSchema = v.union([
  v.literal('local-file'),
  v.literal('cloudflare-observability'),
  v.literal('wrangler-tail'),
  v.literal('client-forward'),
]);

/** Ordered adapter preference for one environment. */
const adapterListSchema = v.array(AdapterKindSchema);

export const AppLogConfigSchema = v.strictObject({
  app: v.pipe(v.string(), v.minLength(1)),
  /**
   * Wrangler worker name for this app. `null` means "not provisioned yet".
   *
   * Nullable rather than `''` on purpose: an empty string satisfies a
   * `minLength: 1` check by not being one, so a `''` placeholder silently
   * defeats the validation that was supposed to catch it — the registry shipped
   * failing its own schema until this was fixed. `DEPLOYMENT_CONFIG` uses the
   * same convention, so "not provisioned" reads the same everywhere.
   */
  workerName: v.union([v.pipe(v.string(), v.minLength(1)), v.null()]),
  /** Which producer sources can appear for this app. */
  sources: v.array(v.union([v.literal('browser'), v.literal('worker'), v.literal('cli')])),
  /**
   * environment -> ordered adapter preference. The first entry is the one used.
   *
   * Spelled as an explicit object rather than `Type.Record` with a union key: a
   * Record over a union key collapses the value type to `never`,
   * which turns a typo in one environment's adapter list into a confusing error
   * far from its cause.
   */
  adapters: v.strictObject({
    local: adapterListSchema,
    staging: adapterListSchema,
    production: adapterListSchema,
  }),
  capabilities: v.array(LogAdapterCapabilitiesSchema),
});

export type AppLogConfig = v.InferOutput<typeof AppLogConfigSchema>;

/**
 * What an environment needs, and where each half of it now lives.
 *
 * There was an `EnvironmentTopologySchema` here, holding a `null` origin per
 * environment, and `DEPLOYMENT_CONFIG.environments` used it. Nothing ever read
 * either: origins come from the gitignored overlay through `topologyFor`, and
 * secret names from `REQUIRED_REMOTE_SECRET_NAMES` below. A committed second
 * copy of a value nothing consults is a registry that can disagree with the one
 * that matters, which is the failure this file exists to prevent — so both are
 * gone rather than left as a shape that looks authoritative.
 */

export const DEPLOYMENT_CONFIG_SCHEMA = v.strictObject({
  /**
   * Project identity, and the stem every derived name uses.
   *
   * Not a secret and not a resource id: it is the name this template keeps when
   * it is renamed, and it is what ties a release record to a project rather than
   * to whichever Worker happened to answer.
   */
  projectName: v.pipe(v.string(), v.minLength(1)),
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
  workerName: v.union([v.pipe(v.string(), v.minLength(1)), v.null()]),
  /** Optional R2 bucket for user uploads. A documented future capability. */
  r2BucketNames: v.strictObject({
    uploads: v.union([v.string(), v.null()]),
  }),
  /**
   * Custom domain. Empty by default; the starter never assumes a domain it does
   * not control, and `configure --provision` is how a user sets this.
   */
  customDomain: v.union([v.string(), v.null()]),
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
  accountId: v.union([v.string(), v.null()]),
});

export type DeploymentConfig = v.InferOutput<typeof DEPLOYMENT_CONFIG_SCHEMA>;

/**
 * Placeholder project identity. Every value here is intentionally empty or
 * obviously generic: a fresh clone has provisioned nothing yet, and the tooling
 * must say so rather than reaching for a previous project's resources.
 */
export const DEPLOYMENT_CONFIG: DeploymentConfig = {
  projectName: 'starter',
  // Origins and resource ids are absent on purpose. A template cannot know the
  // account's `workers.dev` subdomain, and every deployment id starts `null`, so a
  // fresh clone targets nobody. `deploy:configure` writes the real values into the
  // gitignored overlay, which is the only layer any tool reads them from.
  workerName: null,
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
 *
 * None of these is the Cloudflare API token. That token authorises *this tooling*
 * to change the account; these two are read by the *running application*. Keeping
 * them separate is not tidiness — one is a CI secret that must never reach the
 * Worker, and the other two must reach it and must never appear in a log, an argv
 * or a release record.
 */
export const REQUIRED_REMOTE_SECRET_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY',
] as const;
/** Secrets required by the explicit Supabase/Cloud Run deployment profile. */
export const SUPABASE_REMOTE_SECRET_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY',
  'GOOGLE_DISPATCHER_CREDENTIAL',
] as const;

/**
 * Secrets that belong to a Worker rather than to the deployment credential.
 *
 * Named separately because the remediation is different: a missing
 * `CLOUDFLARE_API_TOKEN` means the run is unauthenticated and stops, while a
 * missing runtime secret means the release is live and unable to sign anyone in.
 */
export const RUNTIME_SECRET_NAMES = REQUIRED_REMOTE_SECRET_NAMES;

/** The name of the CI/deployment credential. Never a runtime secret. */
export const DEPLOY_CREDENTIAL_NAME = 'CLOUDFLARE_API_TOKEN';

/** Nonsecret vars every remote environment needs. Names only, never values. */
export const REQUIRED_REMOTE_VAR_NAMES = [
  'DEPLOYMENT_ENV',
  'APP_ORIGIN',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'MAIL_FROM',
  'RELEASE',
] as const;

/**
 * Cloudflare API token permissions the deployment actually needs.
 *
 * Derived from the operations the pipeline performs, not from a documentation page
 * copied by hand — a scope list that grants more than the code uses is a standing
 * invitation, and one that grants less fails on the first real run. Each entry
 * names the call that needs it, so a new step without a scope is a visible
 * omission rather than a runtime 403 nobody can explain.
 *
 * `Workers Scripts: Edit` covers Worker deploys; `R2: Edit` is a separate resource
 * in Cloudflare's model; Workflows ride on the Workers Script permission for the bound
 * Worker. `Account Settings: Read` is what `whoami` and account-scoped queries
 * need.
 */
export interface TokenScope {
  permission: string;
  neededBy: string;
}

export const REQUIRED_TOKEN_SCOPES: readonly TokenScope[] = [
  { permission: 'Account Settings: Read', neededBy: '`wrangler whoami` — the account check' },
  { permission: 'Workers Scripts: Edit', neededBy: 'the web and jobs Worker deploys' },
  { permission: 'R2: Edit', neededBy: '`wrangler r2 bucket create` and the fixture upload' },
] as const;

/**
 * The apps this project deploys.
 *
 * One entry, and the name is the same one `LOG_APPS` in `@starter/schemas` uses,
 * because there is one application: one Worker serves the HTML, the assets and the
 * API. It was `['client', 'api']`, which described a deployment where the browser
 * and the API were separate resources with separate names and separate Postgres
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
 * once per account, so staging and production are two Workers and two Supabase
 * projects. With one set, `--env staging` and `--env production` produced
 * *identical* plans, so the flag changed a notice and nothing else — the worst kind
 * of no-op, because the plan looked environment-specific and was not.
 *
 * Shape is deliberately `{ [environment]: { … } }` rather than a `Record` with an
 * optional key: an environment with no entry must not silently fall back to
 * another environment's Worker. A missing key is a refusal, and `deploy --env`
 * refuses.
 *
 * The set covers the *whole* environment rather than the web Worker alone,
 * because "what would this command change" has to name everything a deployment
 * touches. Before this was extended, a plan printed one Worker and one database
 * while `apply` would go on to build an image, deploy a second Worker and create a
 * bucket — three mutations the reviewed plan did not mention, which makes the plan
 * worthless as the thing an approval is given against.
 *
 * Every field is `null` in the committed template. A template cannot know a
 * bucket name, a workflow identity or a sender address, and a committed one
 * points a fresh clone at somebody else's account.
 */
export interface EnvironmentTargets {
  workerName: string | null;
  /**
   * The jobs Worker for this environment.
   *
   * Separate from `workerName` because it is a separate resource with a separate
   * name, not a second name for the web Worker. It has no public route: the web
   * Worker reaches its Workflows through a binding, so nothing about it is
   * addressable from the internet and nothing about it belongs in `origin`.
   */
  jobsWorkerName: string | null;
  /**
   * The private R2 bucket holding the fixture and job output, or `null`.
   *
   * "private" is a property of how it is bound, not of its name: nothing here
   * configures public access, and the container never receives a bucket key. The
   * field is in the target because a bucket name is a real, billable, per-
   * environment resource that `provision` creates and `apply` writes into.
   */
  mediaBucketName: string | null;
  /** Stable identity of the encode Workflow, used for instance and storage namespacing. */
  encodeWorkflowName: string | null;
  /** Stable identity of the maintenance Workflow. */
  maintenanceWorkflowName: string | null;
  /**
   * The container image this environment runs.
   *
   * A reference, not a digest: the committed value is the Dockerfile the Cloud Run Job builds (`../media/Dockerfile.job`), and the digest that actually ran is
   * recorded per release. Retention and rollback are about digests, and that
   * record lives in the release, not in configuration.
   */
  containerImage: string | null;
  /**
   * The wire protocol the deployed image speaks, e.g. `sample-v1`.
   *
   * In the target rather than derived from the repository because the whole point
   * is to compare what is *deployed* against what this source expects. A container
   * can be one release behind and still serve traffic, which is exactly when an
   * active Workflow must refuse to start rather than send an encode the image will
   * reject. See `compatibility.ts`.
   */
  imageProtocol: string | null;
  /** The measured container profile, e.g. `basic`. Refused if not one the platform offers. */
  containerProfile: string | null;
  /** `disabled` or `encode`. `disabled` is a real refusal, not a placeholder. */
  jobsProfile: string | null;
  /**
   * Public origin for this environment, or `null`.
   *
   * Part of the target rather than a display value because it is the destination
   * verification is made against: a deploy that cannot be addressed cannot be
   * verified, and "the deploy command exited 0" is not a release record.
   */
  origin: string | null;
  /**
   * The verified sender address mail is sent from, or `null`.
   *
   * Configuration, not a secret — but it is also not *ours*: an unverified domain
   * makes real mail fail in a way that looks like a deployment problem. It is in
   * the target so `preflight` can refuse before a deploy rather than after someone
   * tries to sign in.
   */
  mailFrom: string | null;
  /**
   * The HTTPS API origin a packaged native build is compiled against, or `null`.
   *
   * Nonsecret and per environment, because a packaged app cannot be re-pointed at
   * runtime. A native bundle built for staging and shipped as "the app" is a
   * client of the wrong deployment with a valid credential channel, which is why
   * this is resolved here and injected at build time rather than left to each
   * workflow.
   */
  nativeApiOrigin: string | null;
  /** Supabase project identity and public endpoint; publishable configuration. */
  supabaseProjectRef: string | null;
  supabaseUrl: string | null;
  supabaseAuthUrl: string | null;
  /** Publishable Supabase key; safe for Worker/native public configuration. */
  supabasePublishableKey: string | null;
  /** Comma-delimited exact URI allowlist consumed by native and Supabase Auth. */
  nativeRedirectAllowlist: string | null;
  googleProjectId: string | null;
  googleRegion: string | null;
  cloudRunJobName: string | null;
  /** Immutable Artifact Registry image URI, including @sha256 digest. */
  artifactImage: string | null;
  runnerServiceAccount: string | null;
  dispatcherServiceAccount: string | null;
  processorProtocol: string | null;
  processorCpu: string | null;
  processorMemory: string | null;
  processorTimeoutSeconds: string | null;
}

/**
 * Every `null`-able field of {@link EnvironmentTargets}, so a reader cannot add one
 * to the interface and forget the schema (and therefore the offline validation of
 * the CI environment map, and therefore `deploy plan` on a fork).
 */
export const ENVIRONMENT_TARGET_FIELDS = [
  'workerName',
  'jobsWorkerName',
  'mediaBucketName',
  'encodeWorkflowName',
  'maintenanceWorkflowName',
  'containerImage',
  'imageProtocol',
  'containerProfile',
  'jobsProfile',
  'origin',
  'mailFrom',
  'nativeApiOrigin',
  'supabaseProjectRef',
  'supabaseUrl',
  'supabaseAuthUrl',
  'supabasePublishableKey',
  'nativeRedirectAllowlist',
  'googleProjectId',
  'googleRegion',
  'cloudRunJobName',
  'artifactImage',
  'runnerServiceAccount',
  'dispatcherServiceAccount',
  'processorProtocol',
  'processorCpu',
  'processorMemory',
  'processorTimeoutSeconds',
] as const satisfies readonly (keyof EnvironmentTargets)[];

export type EnvironmentTargetField = (typeof ENVIRONMENT_TARGET_FIELDS)[number];

/**
 * Every target field, as a record of `null`.
 *
 * One constructor rather than thirteen literals, because a field added to
 * {@link ENVIRONMENT_TARGET_FIELDS} and forgotten here would be `undefined` in a
 * partial entry — indistinguishable from "not set" everywhere except in the one
 * place it matters: a value that silently falls back to another environment's.
 */
export const nullTargets = (): EnvironmentTargets =>
  Object.fromEntries(
    ENVIRONMENT_TARGET_FIELDS.map((field) => [field, null]),
  ) as unknown as EnvironmentTargets;

/**
 * Build a complete entry from a partial one.
 *
 * For fixtures and for the overlay writer. Without it, every reader of this shape
 * in a test has to spell out thirteen nulls, and the natural thing to do next is
 * to cast — which is how a fixture ends up describing a target that `resolveTarget`
 * could never produce.
 */
export const targets = (partial: Partial<EnvironmentTargets> = {}): EnvironmentTargets => {
  const out = nullTargets();
  for (const field of ENVIRONMENT_TARGET_FIELDS) {
    const value = partial[field];
    out[field] = value === undefined ? null : value;
  }
  return out;
};

/** The values `jobsProfile` may take. `disabled` is a refusal, not an absence. */
export const JOBS_PROFILES = ['disabled', 'encode'] as const;
export type JobsProfile = (typeof JOBS_PROFILES)[number];

/**
 * A shape that is not validated is a comment, so this schema exists to be run.
 *
 * `scripts/src/deploy/variables.ts` parses the CI environment map with it before
 * any value reaches `resolveTarget`, which is what lets a mistyped key fail in the
 * offline `plan` job rather than after a migration.
 *
 * `additionalProperties: false` on purpose: an unknown key in the map is either a
 * typo of one that matters — silently ignored, and then the real value comes from
 * somewhere else — or a value this source does not know how to deploy. Both should
 * stop the run.
 */
/**
 * Every field is optional, and `null` is accepted.
 *
 * Both for the same reason: a CI map is *partial by nature*. An operator writes
 * the fields they have and leaves the rest out, and requiring thirteen keys to
 * describe three real resources is how a configuration stops being editable.
 * Omission and an explicit `null` both mean "not provisioned" here, and
 * `nullTargets()` re-adds every field before anything reads it, so a partial map
 * can never reach `resolveTarget` as an `undefined`.
 */
export const EnvironmentTargetsSchema = v.strictObject({
  workerName: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  jobsWorkerName: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  mediaBucketName: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  encodeWorkflowName: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  maintenanceWorkflowName: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  containerImage: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  imageProtocol: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  containerProfile: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  jobsProfile: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  origin: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  mailFrom: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  nativeApiOrigin: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  supabaseProjectRef: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  supabaseUrl: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  supabaseAuthUrl: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  supabasePublishableKey: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  nativeRedirectAllowlist: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  googleProjectId: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  googleRegion: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  cloudRunJobName: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  artifactImage: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  runnerServiceAccount: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  dispatcherServiceAccount: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  processorProtocol: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  processorCpu: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  processorMemory: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  processorTimeoutSeconds: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
});

export type EnvironmentTargetsInput = v.InferOutput<typeof EnvironmentTargetsSchema>;

/**
 * A CI environment map: every environment this project deploys, by name.
 *
 * `{ [environment]: EnvironmentTargets }` rather than a `Record` with an optional
 * key, for the same reason `EnvironmentTargets` is per-environment: a missing
 * entry is a refusal, never a fallback to another environment.
 */
export const DeploymentEnvironmentMapSchema = v.strictObject({
  staging: v.optional(EnvironmentTargetsSchema),
  production: v.optional(EnvironmentTargetsSchema),
});

export type DeploymentEnvironmentMap = v.InferOutput<typeof DeploymentEnvironmentMapSchema>;

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
