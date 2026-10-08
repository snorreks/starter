// scripts/src/deploy/apply.ts
//
// The mutating half of a deployment, as one ordered pipeline.
//
//   build -> validate artifact -> migrate -> deploy -> verify -> record
//
// The order is the design, and each step exists because the one before it can
// succeed while producing something the next one must refuse:
//
//   1. **Build.** The artifact is produced here, from the source in this checkout,
//     rather than assumed to exist. `wrangler deploy` against a stale or absent
//     build publishes whatever is on disk and reports success.
//   2. **Validate.** `_worker.js` present, files present, digest taken. See
//     `inspectArtifact` for why a green build is not a deployable Worker.
//   3. **Migrate.** Before the deploy, so the new code never meets the old schema.
//     Applied to the *named* database for this environment only.
//   4. **Deploy.** The target resolved by `resolveTarget`, named explicitly.
//   5. **Verify.** The release is fetched and asked what it is. A deploy that
//     exited 0 has still not proved anything is serving.
//   6. **Record.** Source SHA, artifact digest, destination, provider identity and
//     smoke result, written down.
//
// Every step takes its effect through an injected function, so the whole pipeline
// including each failure and each *partial* failure is reachable in a test. That
// is not decoration: a migration that succeeds and a deploy that then fails leaves
// the system in a state no "it worked" test would ever construct, and resuming
// from it is exactly what needs to be known.
//
// Nothing here decides *whether* to deploy. That is `--yes`, and it is checked
// before the first step, not between steps.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { IDEMPOTENCY_KEY_HEADER } from '@starter/schemas/jobs';
import { captureWrangler, runWrangler } from '../cloudflare/wrangler.ts';
import { CLIENT_DIR, REPO_ROOT } from '../shared/paths.ts';
import { imageProtocolProblem } from './compatibility.ts';
import { parseDeploymentIdentity } from './deployment_identity.ts';
import {
  applyDispatcherGrant,
  applyGoogleJob,
  getGoogleRunnerSubject,
  verifyGoogleArtifactImage,
} from './providers/google.ts';
import {
  applySupabaseAuthConfig,
  runSupabaseMigration,
  supabaseMigrationArgs,
} from './providers/supabase.ts';
import { bucketExists } from './provision.ts';
import {
  type ArtifactCheck,
  inspectArtifact,
  type ReadinessSmoke,
  type ReleaseRecord,
  readReleaseRecord,
  type SmokeResult,
  sourceRevision,
  supabaseSchemaRevision,
  writeReleaseRecord,
} from './release.ts';
import { remoteConfigPath, renderRemoteConfig, writeRemoteConfig } from './remote_config.ts';
import type { ResolvedTarget } from './target.ts';

/** Where the built Worker and its assets live. */
export const BUILD_DIR = join(CLIENT_DIR, '.svelte-kit', 'cloudflare');

/** The endpoint that proves release identity. Public, and safe to fetch. */
export const HEALTH_PATH = '/health';

/**
 * The endpoint that proves the release can actually serve.
 *
 * Also public and also safe to fetch, and also asked on every verification — the
 * two are different questions. `/health` reads configuration, so nothing in it can
 * fail on its own: a Worker whose D1 binding points at a deleted database answers
 * `200 ok` with the right release id forever. Recording that as a verified release
 * is how a deploy reports success while every real request 500s.
 */
export const READINESS_PATH = '/health/ready';

export type Phase =
  | 'build'
  | 'validate'
  | 'schema'
  | 'storage'
  | 'image'
  | 'jobs'
  | 'web'
  | 'verify'
  | 'record';

/**
 * The pipeline's phases, in dependency order.
 *
 * The order is the design and each step exists because the one before it can
 * succeed while producing something the next one must refuse:
 *
 *   schema  reviewed migrations, so new code never meets the old schema;
 *   storage the private bucket and the fixture, because the encode Workflow
 *           fetches the fixture and nothing else can be verified without it;
 *   image   the container image, because the jobs Worker declares it as a build
 *           input and a Worker whose image cannot be built fails at deploy time
 *           with an opaque error;
 *   jobs    the jobs Worker, its Workflows and its schedule — before the web
 *           Worker, so the web Worker is never live pointing at a binding that
 *           does not resolve yet;
 *   web     the public origin last, because it is the only resource a user can
 *           see and the one whose failure is visible;
 *   verify  release identity, then readiness, then a real encode and download —
 *           in that order, and each one capable of failing the release.
 *
 * `migrate` and `deploy` were the old names and are deliberately gone: they named
 * two commands rather than four dependencies, so the plan a reviewer read did not
 * match the order the pipeline ran.
 */
export const PHASES: readonly Phase[] = [
  'schema',
  'storage',
  'image',
  'jobs',
  'web',
  'verify',
  'record',
];

export interface StepOutcome {
  phase: Phase;
  ok: boolean;
  /** One line, safe to print. Never contains a credential or a response body. */
  detail: string;
}

export interface ApplyResult {
  ok: boolean;
  outcomes: StepOutcome[];
  /** Steps that ran, in order, as `wrangler <args…>`. The argv a review needs. */
  argv: string[][];
  record: ReleaseRecord | null;
  /**
   * Every component this run changed, whether or not the pipeline completed.
   *
   * Written even on a failure. "What did the last half-successful deploy actually
   * do?" is the question an operator has at that moment, and a record that only
   * exists on success answers it with silence.
   */
  components: MutatedComponent[];
  /** Present when the pipeline stopped early. */
  stoppedAt: Phase | null;
}

/** One mutated component, recorded so a partial failure is diagnosable. */
export interface MutatedComponent {
  phase: Phase;
  /** What the thing is called at the provider. Never a value. */
  identity: string;
  /** What produced it: a source SHA, an artifact digest, an image digest. */
  source: string;
  /** Provider-side identity, when the provider reports one. */
  providerId?: string | null;
  /** The wire protocol, for a component that speaks one. */
  protocol?: string | null;
}

export interface ApplyOptions {
  target: ResolvedTarget;
  /** True only after explicit consent. Nothing runs without it. */
  consented: boolean;
  /** Produce the artifact. Injected so a test can supply or withhold one. */
  build?: () => { ok: boolean; detail: string };
  /** Inspect the built artifact. Defaults to the real filesystem. */
  inspect?: () => ArtifactCheck;
  /** Run a wrangler subcommand, returning its exit code. */
  run?: (command: string, args: readonly string[], options: { cwd: string }) => number;
  /** Injected provider boundary for exact Supabase migration identity and argv fixtures. */
  migrateSupabase?: (target: ResolvedTarget) => { code: number; stderr: string };
  configureSupabaseAuth?: (target: ResolvedTarget) => Promise<unknown>;
  configureGoogleJob?: (target: ResolvedTarget) => Promise<unknown>;
  configureGoogleGrant?: (target: ResolvedTarget) => Promise<void>;
  verifyGoogleImage?: (target: ResolvedTarget) => Promise<{ image: string; digest: string }>;
  /** Fetch the release for verification. Injected so failures are reachable. */
  fetch?: typeof globalThis.fetch;
  /** Read-only wrangler capture, for the provider's deployment identity. */
  capture?: (args: readonly string[]) => { ok: boolean; stdout: string; stderr: string };
  root?: string;
  /** Skip migrations. Explicit, and recorded in the release record. */
  skipMigrations?: boolean;
  /**
   * A runtime session token used to prove a real encode, when one is available.
   *
   * Optional on purpose. A release verification normally has a Cloudflare API token
   * and no user session, so the tiny-job probe reports which half it established
   * rather than pretending the whole thing passed. Never recorded, never printed.
   */
  verifyToken?: string | null;
  /**
   * Run a subset of the pipeline.
   *
   * `--only jobs` is the supported way to introduce compute into a live
   * environment: the image and the Workflows have to exist and be speaking the same
   * protocol *before* the web Worker is pointed at them. Running the whole pipeline
   * again is not the answer, because it re-runs the migration and re-publishes the
   * web Worker for no reason.
   */
  only?: readonly Phase[];
  now?: () => string;
}

const ok = (phase: Phase, detail: string): StepOutcome => ({ phase, ok: true, detail });
const bad = (phase: Phase, detail: string): StepOutcome => ({ phase, ok: false, detail });

/**
 * The migration argv for one environment, or a refusal.
 *
 * The single source for what a migration looks like. `planDeploy` and `apply` both call
 * it, because they had already drifted: the plan's hand-written copy omitted
 * `--remote`, so the thing an operator approved was not the thing that ran. A dry run
 * that renders different argv from the real run is a dry run that can lie.
 *
 * `databaseId` comes from the already-validated target rather than being resolved here,
 * so the migration destination and the deploy destination cannot disagree.
 * `wranglerDatabaseId` is then the *provider's* view of that environment, and the two
 * are compared — which is the check the argv alone cannot make, because both
 * commands name the binding `DB` rather than a database.
 *
 * "Reviewed" is enforced structurally rather than by policy: only files already
 * committed under the migrations directory are applied, and this never generates
 * one. A migration that has not been reviewed is one that has not been committed,
 * and the fix is to commit it, not to apply it.
 */
export const migrationStep = (
  target: ResolvedTarget,
  root: string = REPO_ROOT,
): { ok: true; args: string[]; description: string } | { ok: false; detail: string } => {
  if (target.deploymentProfile === 'supabase') {
    try {
      return {
        ok: true,
        args: supabaseMigrationArgs(target, 'push'),
        description: `Apply reviewed Supabase migrations to project ${target.supabase?.projectRef}`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : 'Invalid Supabase target.',
      };
    }
  }
  if (target.d1DatabaseId.trim() === '') {
    return { ok: false, detail: 'No D1 database id in the resolved target; refusing to migrate.' };
  }

  try {
    renderRemoteConfig({ target, root });
  } catch (error) {
    return {
      ok: false,
      detail: `Cannot render the migration/deploy config: ${error instanceof Error ? error.message : 'invalid source config'}`,
    };
  }

  return {
    ok: true,
    args: [
      'd1',
      'migrations',
      'apply',
      'DB',
      '--remote',
      '--config',
      remoteConfigPath({ target, root }),
    ],
    description: `Apply reviewed migrations to ${target.d1DatabaseId} (${target.environment})`,
  };
};

/**
 * The jobs Worker deploy argv, or `null` when this environment has no compute.
 *
 * Shared with the planner, and it has to be: `apply` deployed the jobs Worker and
 * `planDeploy` did not mention it, so the plan a reviewer approved was missing one of
 * the four things the pipeline changed. A dry run that renders different argv from the
 * real run is a dry run that can lie, which is the whole claim being tested.
 *
 * `root` is a parameter rather than `REPO_ROOT` for the same reason `deployStep`'s
 * callers take one: the config path must be resolved against the tree being deployed.
 */
export const jobsDeployStep = (
  target: ResolvedTarget,
  sourceSha: string,
  root: string = REPO_ROOT,
): { description: string; args: string[] } | null => {
  const { compute } = target;
  if (!compute.enabled || compute.jobsWorkerName === null) {
    return null;
  }

  return {
    description: `Deploy the jobs Worker ${compute.jobsWorkerName} and its Workflows`,
    args: [
      'deploy',
      '--name',
      compute.jobsWorkerName,
      '--config',
      remoteConfigPath({ target, root, kind: 'jobs' }),
      // The jobs Worker carries the *same* release identity as the web Worker. Two
      // SHAs for one deployment would make "which code is live" unanswerable.
      '--var',
      `RELEASE:${sourceSha}`,
    ],
  };
};

/** The deploy argv for one environment, carrying the release identity. */
export const deployStep = (
  target: ResolvedTarget,
  sourceSha: string,
  digest: string | null,
  root: string = REPO_ROOT,
): { description: string; args: string[] } => ({
  description: `Deploy ${target.workerName} and its assets to ${target.origin}`,
  args: [
    'deploy',
    // The Worker name is passed explicitly rather than read from the config, so
    // the name the plan printed is the name that gets deployed.
    '--name',
    target.workerName,
    '--config',
    remoteConfigPath({ target, root }),
    // RELEASE is a git SHA: public information by construction, which is why it is
    // safe as a var and why /health can report it. It is what lets verification
    // prove *which* release is answering rather than merely that something is.
    '--var',
    `RELEASE:${sourceSha}`,
    // The digest travels with the release as metadata. Wrangler records it, and it
    // is what makes the recorded artifact independently checkable against the
    // provider.
    '--message',
    `source_sha=${sourceSha},artifact=${digest ?? 'unknown'}`,
  ],
});

/**
 * Record the migration argv, so `apply` executes the list `planDeploy` printed.
 *
 * A wrapper rather than a second implementation: the two callers want different
 * things from the same step, and a second copy of the argv is how they drifted.
 */
const migrate = (
  target: ResolvedTarget,
  argv: string[][],
  root: string = REPO_ROOT,
): { ok: boolean; detail: string } => {
  const step = migrationStep(target, root);

  if (!step.ok) {
    return { ok: false, detail: step.detail };
  }

  argv.push(step.args);
  return { ok: true, detail: `migrated ${target.d1DatabaseId}` };
};

/**
 * Ask one probe a question, and return its status. Never throws.
 *
 * The body is read for the fields this function is explicitly asking about and for
 * nothing else: `/health` for `release`, `/health/ready` for `ok`. See the note on
 * `smoke` about why a response body is never retained.
 */
const probe = async (
  url: string,
  path: string,
  doFetch: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<{
  status: number | null;
  body: Record<string, unknown> | null;
  problem: string | null;
}> => {
  let response: Response;
  try {
    // Bounded. An origin that accepts the connection and never answers would
    // otherwise hold the apply job open until the runner's own timeout, with the
    // release deployed and no verdict on it.
    response = await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      status: null,
      body: null,
      problem: `Could not reach ${path}: ${error instanceof Error ? error.message : 'network error'}`,
    };
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return {
        status: response.status,
        body: null,
        problem: `Timed out reading ${path} after ${timeoutMs}ms`,
      };
    }
    // A non-JSON body is a failed verification, not a crash: an HTML error page
    // from a misconfigured origin is precisely the failure worth reporting.
    body = null;
  }

  return { status: response.status, body, problem: null };
};

/**
 * Fetch `/health` and `/health/ready`, and report whether this release is live and
 * able to serve.
 *
 * Liveness first, and it is not enough on its own. A 200 from `/health` proves the
 * isolate is serving and that it identifies itself as the release this run
 * published; it cannot prove the bindings work, because it does not use them.
 * Readiness is asked separately and a failure there fails the verification, so the
 * recorded release says "deployed and unable to serve" rather than "verified".
 *
 * The response body is *not* retained. Both endpoints are public by design, but a
 * release record outlives the deployment, and a record that can contain whatever an
 * origin chose to return is a record that eventually contains something sensitive.
 * Only the status and the release id are kept.
 */
export const smoke = async (
  target: ResolvedTarget,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
  options: { expectedRelease?: string; timeoutMs?: number } = {},
): Promise<SmokeResult> => {
  const expected = options.expectedRelease;
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;

  const live = await probe(`${target.origin}${HEALTH_PATH}`, HEALTH_PATH, doFetch, timeoutMs);

  if (live.problem !== null) {
    return {
      ok: false,
      path: HEALTH_PATH,
      status: live.status,
      reportedRelease: null,
      readiness: null,
      problem: live.problem,
    };
  }

  const reportedRelease = readString(live.body, 'release');

  if (live.status === null || live.status >= 400) {
    return {
      ok: false,
      path: HEALTH_PATH,
      status: live.status,
      reportedRelease,
      readiness: null,
      problem: `${HEALTH_PATH} answered ${String(live.status)}`,
    };
  }

  // A 200 that does not identify its release is a failed verification.
  //
  // This is the case a status-code-only check gets wrong, and it is the common one:
  // a misconfigured origin serves the SPA shell, or a proxy answers on the
  // hostname, and both return 200 with something that is not `/health`. Treating
  // that as a successful deploy is how a broken release gets recorded as released
  // — and it is the same class of defect this repository has already hit once,
  // where `not_found_handling: "404-page"` answered a navigation with 404 while
  // `curl` saw 200.
  if (reportedRelease === null) {
    return {
      ok: false,
      path: HEALTH_PATH,
      status: live.status,
      reportedRelease: null,
      readiness: null,
      problem:
        `${HEALTH_PATH} answered ${String(live.status)} without identifying a release. ` +
        "The response is not this application's health endpoint — a shell, a proxy or " +
        'an SPA fallback is serving this origin.',
    };
  }

  // Identity, not just liveness. Any release answering with a 200 would otherwise
  // pass, including the *previous* one still serving while the new deploy
  // propagates — which is precisely the state in which a deploy is reported done
  // and the site is still wrong.
  if (expected !== undefined && reportedRelease !== expected) {
    return {
      ok: false,
      path: HEALTH_PATH,
      status: live.status,
      reportedRelease,
      readiness: null,
      problem:
        `${HEALTH_PATH} reports release "${reportedRelease}" but this deploy published ` +
        `"${expected}".`,
    };
  }

  // Liveness is established. Now the question that decides whether this release can
  // take traffic. Asked with its own bounded request rather than sharing the
  // liveness budget: a slow readiness probe is exactly the condition being
  // detected, and it must not be able to consume the liveness timeout as well.
  const ready = await probe(
    `${target.origin}${READINESS_PATH}`,
    READINESS_PATH,
    doFetch,
    timeoutMs,
  );

  const readiness: ReadinessSmoke = {
    path: READINESS_PATH,
    ok: false,
    status: ready.status,
    problem: ready.problem,
  };

  if (ready.problem === null) {
    if (ready.status === null || ready.status >= 400) {
      readiness.problem = `${READINESS_PATH} answered ${String(ready.status)}. The release is live but cannot serve: a database-backed request fails right now.`;
    } else if (readBoolean(ready.body, 'ok') !== true) {
      // A 200 whose payload says `ok: false` is a failure too. The contract is the
      // report, not the status line.
      readiness.problem = `${READINESS_PATH} reported that this release is not ready.`;
    } else {
      readiness.ok = true;
      readiness.problem = null;
    }
  }

  return {
    ok: readiness.ok,
    path: readiness.ok ? HEALTH_PATH : READINESS_PATH,
    status: live.status,
    reportedRelease,
    readiness,
    problem: readiness.problem,
  };
};

/** A string field, or null. A non-string is treated as absent, not coerced. */
const readString = (body: Record<string, unknown> | null, key: string): string | null => {
  const value = body?.[key];
  return typeof value === 'string' ? value : null;
};

const readBoolean = (body: Record<string, unknown> | null, key: string): boolean | null => {
  const value = body?.[key];
  return typeof value === 'boolean' ? value : null;
};

/**
 * How long verification waits before giving up.
 *
 * A bound, not a preference: without one a slow origin blocks the deploy job for
 * its full timeout budget after the release is already live. Ten seconds is far
 * longer than a `GET /health` should take and far shorter than a CI job.
 */
export const VERIFY_TIMEOUT_MS = 10_000;

/**
 * The provider's identity for the release that is now active, or `null`s.
 *
 * Wrangler history is not ordered newest-first. Select by its precise timestamp,
 * and report a version only when it owns all traffic. Unparseable history stays
 * unreported rather than borrowing identifiers from an older release.
 * `wrangler deployments list` is read-only.
 */
export const deploymentIdentity = (
  target: ResolvedTarget,
  capture: (args: readonly string[]) => { ok: boolean; stdout: string; stderr: string },
): { deploymentId: string | null; versionId: string | null } => {
  const result = capture(['deployments', 'list', '--name', target.workerName, '--json']);
  if (!result.ok) {
    return { deploymentId: null, versionId: null };
  }

  return parseDeploymentIdentity(result.stdout);
};

/**
 * Run the pipeline.
 *
 * Stops at the first failing step and says which one. Resume behaviour is
 * explicit rather than inferred: every step is idempotent given the step before
 * it, so re-running `apply` after a deploy failure re-validates and re-verifies
 * rather than re-migrating blindly — `wrangler d1 migrations apply` applies only
 * what the journal has not recorded.
 */
export const apply = async (options: ApplyOptions): Promise<ApplyResult> => {
  const { target } = options;
  const root = options.root ?? REPO_ROOT;
  // Both branches annotated rather than inferred: the fallback arrow has no
  // contextual type of its own, so without them `run` becomes a union of two
  // differently-typed callables and every call site below reports "not callable".
  const run: (command: string, args: readonly string[], options: { cwd: string }) => number =
    options.run ?? ((_command, args, runOptions) => runWrangler(args, runOptions));
  const inspect = options.inspect ?? ((): ArtifactCheck => inspectArtifact(BUILD_DIR));
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? ((): string => new Date().toISOString());
  const capture = options.capture ?? captureWrangler;

  const outcomes: StepOutcome[] = [];
  const argv: string[][] = [];
  const components: MutatedComponent[] = [];

  /**
   * A phase the caller did not select.
   *
   * Reported as `ok` with the word *skipped*, never as absent. A release record
   * that omits a phase is a record that does not say whether the step was skipped
   * by request or forgotten by a bug, and those need different responses.
   */
  const skipped = (phase: Phase): StepOutcome =>
    ok(phase, 'skipped by --only; this release did not touch it');

  const wants = (phase: Phase): boolean =>
    options.only === undefined || options.only.includes(phase);

  // `detail` is accepted and deliberately unused here: the reason is already in
  // `outcomes`, and printing it twice would give the same sentence two sources of
  // truth. The parameter stays so every refusal reads the same at the call site.
  const stop = (_phase: Phase, _detail: string): ApplyResult => ({
    ok: false,
    outcomes,
    argv,
    record: null,
    components,
    stoppedAt: _phase,
  });

  if (!options.consented) {
    // Checked before the first step rather than before the first mutation: there
    // is no partial state to reason about if nothing has run.
    //
    // The refusal is pushed as an outcome, not only passed to `stop`. `stop` does
    // not print anything, and `renderApply` tells the reader to look at the details
    // *above* — so a refusal that pushed no outcome renders as "Stopped at: build"
    // with nothing above it. That is the exact shape this repository calls a
    // command that fails without saying why.
    const detail = 'Refusing to deploy without --yes. Nothing has been changed.';
    outcomes.push(bad('build', detail));
    return stop('build', detail);
  }

  const revision = sourceRevision(options.root);
  try {
    const googleToken =
      target.deploymentProfile === 'supabase' && target.compute.enabled
        ? process.env.GOOGLE_ACCESS_TOKEN
        : undefined;
    if (target.deploymentProfile === 'supabase' && target.compute.enabled && !googleToken) {
      throw new Error('GOOGLE_ACCESS_TOKEN is required to resolve the runner identity.');
    }
    const runnerSubject = googleToken
      ? await getGoogleRunnerSubject({ target, accessToken: googleToken })
      : undefined;
    writeRemoteConfig({ target, root: options.root, runnerSubject });
    if (target.compute.enabled) {
      writeRemoteConfig({ target, root: options.root, kind: 'jobs', runnerSubject });
    }
  } catch (error) {
    const detail = `Cannot generate remote configuration: ${error instanceof Error ? error.message : 'invalid configuration'}`;
    outcomes.push(bad('build', detail));
    return stop('build', detail);
  }

  // -- build ---------------------------------------------------------------
  // The artifact is produced here, from the source in this checkout, rather than
  // assumed to exist. A `wrangler deploy` against a stale or absent build publishes
  // whatever is on disk and reports success.
  if (options.build !== undefined) {
    const built = options.build();
    if (!built.ok) {
      const detail = `The build failed: ${built.detail}`;
      outcomes.push(bad('build', detail));
      return stop('build', detail);
    }
    outcomes.push(ok('build', built.detail));
  }

  // -- validate ------------------------------------------------------------
  // Read-only, and deliberately *before* the migration. A migration applied with no
  // deployable artifact in hand leaves the schema ahead of the running code for no
  // reason, and the remedy is to build — not to apply the schema and try again.
  const artifact = inspect();
  if (!artifact.ok) {
    const problems = artifact.problems.join(' ');
    outcomes.push(bad('validate', problems));
    return stop('validate', problems);
  }
  outcomes.push(ok('validate', `${artifact.fileCount} files, digest ${artifact.digest}`));

  // -- schema --------------------------------------------------------------
  // Where `migrate` was. Renamed to the dependency it satisfies, because the
  // pipeline now has four phases and `deploy` no longer names one of them.
  //
  // Before the web deploy, so new code never meets the old schema.
  if (!wants('schema')) {
    outcomes.push(skipped('schema'));
  } else if (options.skipMigrations === true) {
    outcomes.push(
      ok('schema', 'skipped by request; the schema is whatever the last apply left behind'),
    );
  } else {
    const migrated = migrate(target, argv, root);
    if (!migrated.ok) {
      outcomes.push(bad('schema', migrated.detail));
      return stop('schema', migrated.detail);
    }
    const migration =
      target.deploymentProfile === 'supabase'
        ? (
            options.migrateSupabase ??
            ((resolvedTarget) => {
              const result = runSupabaseMigration(resolvedTarget, 'push');
              return { code: result.code, stderr: result.stderr };
            })
          )(target)
        : {
            code: run('wrangler', argv[argv.length - 1] as string[], { cwd: CLIENT_DIR }),
            stderr: '',
          };
    if (migration.code !== 0) {
      const recovery =
        target.deploymentProfile === 'supabase'
          ? 'Check `supabase_migrations.schema_migrations` before retrying; re-running `apply` is safe because Supabase records applied migrations there.'
          : 're-running `apply` is safe, because D1 records each migration in its journal and re-applies only what is missing.';
      const stderr = migration.stderr.trim();
      const detail =
        `Migration failed with exit code ${migration.code}. The schema may be partly applied. ${recovery}` +
        (stderr.length > 0 ? `\n${stderr.slice(0, 8_000)}` : '');
      outcomes.push(bad('schema', detail));
      return stop('schema', detail);
    }
    components.push({
      phase: 'schema',
      identity:
        target.deploymentProfile === 'supabase'
          ? (target.supabase?.projectRef ?? 'unknown')
          : target.d1DatabaseId,
      source: revision.sha,
    });
    outcomes.push(ok('schema', migrated.detail));
  }

  // -- storage ------------------------------------------------------------
  // A dependency assertion rather than a second write path: `provision` created the
  // bucket and uploaded the fixture, and re-uploading here would be a second way to
  // write the same object. What the phase does is *prove* the dependency, so a
  // pipeline that skipped provisioning fails here with a remedy instead of admitting
  // a job whose fixture is missing.
  if (!wants('storage')) {
    outcomes.push(skipped('storage'));
  } else if (target.compute.enabled && target.compute.mediaBucketName !== null) {
    const listed = capture(['r2', 'bucket', 'list', '--json']);
    if (!listed.ok || !bucketExists(listed.stdout, target.compute.mediaBucketName)) {
      const detail =
        `The private bucket ${target.compute.mediaBucketName} is not readable in this account, so ` +
        'the encode path has nowhere to read the fixture from or write output to.\n' +
        `  bun run deploy:provision --env ${target.environment} --yes\n` +
        '  Nothing has been changed.';
      outcomes.push(bad('storage', detail));
      return stop('storage', detail);
    }
    components.push({
      phase: 'storage',
      identity: target.compute.mediaBucketName,
      source: revision.sha,
    });
    outcomes.push(ok('storage', `private bucket ${target.compute.mediaBucketName} readable`));
  } else {
    outcomes.push(ok('storage', 'no compute profile: this release has no bucket to prepare'));
  }

  // -- image --------------------------------------------------------------
  // The image is not uploaded separately. Cloudflare builds it from the Dockerfile
  // the jobs Worker declares, and what runs is a digest the provider assigns —
  // recorded per release rather than asserted here, because a build that has not
  // happened cannot be named. What can be checked offline is the protocol, and it
  // is checked before anything is mutated.
  if (!wants('image')) {
    outcomes.push(skipped('image'));
  } else if (target.compute.enabled) {
    // The *recorded* release, not `null`. Passing null meant "nothing has ever been
    // deployed", which is true only on a first deploy; on every later one it skipped
    // the one check that matters — a running image speaking another protocol — and
    // the deploy went ahead over live Workflow instances.
    const incompatible = imageProtocolProblem(
      target,
      lastComputeProtocol(options.root, target.environment),
    );
    if (incompatible !== null) {
      outcomes.push(bad('image', `${incompatible.reason}\n  ${incompatible.remedy}`));
      return stop('image', incompatible.reason);
    }
    if (target.deploymentProfile === 'supabase') {
      const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
      if (!accessToken) {
        const detail =
          'GOOGLE_ACCESS_TOKEN is required to verify the immutable Cloud Run image digest.';
        outcomes.push(bad('image', detail));
        return stop('image', detail);
      }
      try {
        const image = await (
          options.verifyGoogleImage ??
          ((resolvedTarget) => verifyGoogleArtifactImage({ target: resolvedTarget, accessToken }))
        )(target);
        components.push({
          phase: 'image',
          identity: image.image,
          source: revision.sha,
          protocol: target.supabase?.protocol,
        });
        outcomes.push(
          ok('image', `Artifact Registry confirmed ${image.digest} for ${image.image}`),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Google image verification failed.';
        outcomes.push(bad('image', detail));
        return stop('image', detail);
      }
    } else {
      components.push({
        phase: 'image',
        identity: target.compute.containerImage ?? 'unconfigured',
        source: revision.sha,
        protocol: target.compute.imageProtocol,
      });
      outcomes.push(
        ok(
          'image',
          `${target.compute.containerImage} must speak ${target.compute.imageProtocol ?? 'an unstated protocol'} ` +
            `on profile ${target.compute.containerProfile ?? 'unstated'}`,
        ),
      );
    }
  } else {
    outcomes.push(ok('image', 'no compute profile: this release builds no image'));
  }

  // -- jobs ---------------------------------------------------------------
  // Before the web Worker, so the web Worker is never live pointing at a binding
  // that does not resolve yet.
  if (!wants('jobs')) {
    outcomes.push(skipped('jobs'));
  } else {
    if (target.deploymentProfile === 'supabase' && target.supabase !== null) {
      const supabaseToken = process.env.SUPABASE_ACCESS_TOKEN;
      const googleToken = target.compute.enabled ? process.env.GOOGLE_ACCESS_TOKEN : undefined;
      if (!supabaseToken || (target.compute.enabled && !googleToken)) {
        const detail =
          'SUPABASE_ACCESS_TOKEN is required for Auth callbacks; enabled compute also requires GOOGLE_ACCESS_TOKEN for the Cloud Run Job.';
        outcomes.push(bad('jobs', detail));
        return stop('jobs', detail);
      }
      try {
        await (
          options.configureSupabaseAuth ??
          ((resolvedTarget) =>
            applySupabaseAuthConfig({ target: resolvedTarget, accessToken: supabaseToken }))
        )(target);
        components.push({
          phase: 'jobs',
          identity: `${target.supabase.projectRef}:auth-callbacks`,
          source: revision.sha,
        });
        if (googleToken) {
          await (
            options.configureGoogleJob ??
            ((resolvedTarget) =>
              applyGoogleJob({ target: resolvedTarget, accessToken: googleToken }))
          )(target);
          components.push({
            phase: 'jobs',
            identity: `${target.supabase.googleProjectId}/${target.supabase.googleRegion}/${target.supabase.jobName}`,
            source: revision.sha,
            protocol: target.supabase.protocol,
          });
          await (
            options.configureGoogleGrant ??
            ((resolvedTarget) =>
              applyDispatcherGrant({ target: resolvedTarget, accessToken: googleToken }))
          )(target);
          components.push({
            phase: 'jobs',
            identity: `${target.supabase.dispatcherServiceAccount}:roles/run.invoker`,
            source: revision.sha,
          });
        }
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : 'Provider configuration failed; later stages were stopped.';
        outcomes.push(bad('jobs', detail));
        return stop('jobs', detail);
      }
    }
    const step = jobsDeployStep(target, revision.sha, root);
    if (step === null) {
      outcomes.push(ok('jobs', 'no compute profile: this release has no jobs Worker'));
    } else {
      argv.push(step.args);

      const jobsCode = run('wrangler', step.args, { cwd: root });
      if (jobsCode !== 0) {
        const detail =
          `The jobs Worker deploy failed with exit code ${jobsCode}. The web Worker has NOT been ` +
          'updated, so it still points at the previous Workflow definitions and the previous ' +
          'image. See docs/deployment.md for the recovery order.';
        outcomes.push(bad('jobs', detail));
        return stop('jobs', detail);
      }
      components.push({
        phase: 'jobs',
        identity: target.compute.jobsWorkerName as string,
        source: revision.sha,
        protocol: target.compute.imageProtocol,
      });
      outcomes.push(
        ok(
          'jobs',
          `${target.compute.jobsWorkerName} with ${target.compute.encodeWorkflowName} and ` +
            `${target.compute.maintenanceWorkflowName}`,
        ),
      );
    }
  }

  // -- web ----------------------------------------------------------------
  if (!wants('web')) {
    outcomes.push(skipped('web'));
    // No record: nothing that verification covers was published, so a release
    // record would describe a release that did not happen.
    outcomes.push(ok('record', 'web Worker not selected; nothing was recorded'));
    return { ok: true, outcomes, argv, record: null, components, stoppedAt: null };
  }

  const deployArgs = deployStep(target, revision.sha, artifact.digest, options.root).args;
  argv.push(deployArgs);

  const deployCode = run('wrangler', deployArgs, { cwd: CLIENT_DIR });
  if (deployCode !== 0) {
    const detail =
      `Deploy failed with exit code ${deployCode}. The schema is ahead of the running ` +
      'code, which is why a rollback does not roll the schema back: see the recovery ' +
      'procedure in docs/deployment.md.';
    outcomes.push(bad('web', detail));
    return stop('web', detail);
  }
  components.push({ phase: 'web', identity: target.workerName, source: revision.sha });
  outcomes.push(ok('web', `${target.workerName} deployed to ${target.origin}`));

  // -- verify -------------------------------------------------------------
  // Three questions, in this order and each capable of failing the release:
  // liveness identity, readiness, and — when the compute profile is on — a real
  // tiny job whose output is fetched. `/health` alone proves neither of the other
  // two: it reads configuration and never touches a binding.
  const smokeResult = await smoke(target, doFetch, { expectedRelease: revision.sha });
  if (!smokeResult.ok) {
    const detail =
      `Deployed, but the release did not verify: ${smokeResult.problem ?? 'unknown'}. ` +
      'The deployment is live and its identity is unconfirmed — treat this as a failure, ' +
      'not as a warning.';
    outcomes.push(bad('verify', detail));
    // Still recorded. A failed verification is exactly the situation in which the
    // record matters most, and not writing it would lose the deployment id that
    // identifies what to roll back.
    const record = buildRecord(target, artifact, smokeResult, now(), options, components);
    writeReleaseRecord(record, options.root);
    outcomes.push(ok('record', 'recorded despite the failed verification'));
    return { ok: false, outcomes, argv, record, components, stoppedAt: 'verify' };
  }
  outcomes.push(
    ok(
      'verify',
      `${smokeResult.path} -> ${smokeResult.status}, release ${smokeResult.reportedRelease ?? 'unreported'}; ` +
        `${READINESS_PATH} -> ${smokeResult.readiness?.status} (ready)`,
    ),
  );

  const probe = await verifyTinyJob(target, doFetch, {
    // `verifyToken` is the *runtime* credential a signed-in verification uses. It
    // is optional and never recorded: with it, verification can prove a real encode;
    // without it, verification says exactly which half it established.
    token: options.verifyToken ?? null,
  });
  if (!probe.ok) {
    const reason = probe.detail ?? 'the verification encode did not succeed';
    outcomes.push(bad('verify', reason));
    const failed = { ...smokeResult, ok: false, problem: reason };
    const record = buildRecord(target, artifact, failed, now(), options, components);
    writeReleaseRecord(record, options.root);
    outcomes.push(ok('record', 'recorded despite the failed verification'));
    return { ok: false, outcomes, argv, record, components, stoppedAt: 'verify' };
  }
  if (probe.detail !== null) {
    outcomes.push(ok('verify', probe.detail));
  }

  // -- record -------------------------------------------------------------
  const record = buildRecord(target, artifact, smokeResult, now(), options, components);
  writeReleaseRecord(record, options.root);
  outcomes.push(ok('record', `wrote ${target.environment} release record`));

  return { ok: true, outcomes, argv, record, components, stoppedAt: null };
};

/**
 * The image protocol the last recorded release ran, or `null`.
 *
 * `null` covers three states that mean the same thing to `imageProtocolProblem`:
 * no release record, a web-only release with no compute half, and a release that
 * predates the recorded identity. The third is the interesting one — it is why the
 * function distinguishes "recorded none" from "recorded something else", rather than
 * treating an absent value as compatible.
 */
const lastComputeProtocol = (
  root: string | undefined,
  environment: string,
): { imageProtocol: string | null } | null => {
  const record = readReleaseRecord(environment, root ?? REPO_ROOT);
  if (record === null || record.compute === undefined || record.compute === null) {
    return null;
  }
  return { imageProtocol: record.compute.imageProtocol };
};

/**
 * The one real encode a deployment has to be able to observe.
 *
 * Deliberately absent rather than faked when the compute profile is off: a
 * verification that reports "job skipped" as though it had passed is the exact
 * shape of a check that succeeds while doing nothing. With the profile off there is
 * no job to run, and the release record says so.
 *
 * With it on, this submits one admitted fixture, waits for a terminal state within
 * a bounded budget, and fetches the output bytes. It needs an authenticated
 * session, which a release verification does not have — so it is a *capability*
 * probe reported honestly rather than a promise: when it cannot authenticate, it
 * says which half it could establish.
 */
export const verifyTinyJob = async (
  target: ResolvedTarget,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
  options: { token?: string | null; timeoutMs?: number; idempotencyKey?: string } = {},
): Promise<{ ok: boolean; detail: string | null }> => {
  if (!target.compute.enabled) {
    return {
      ok: true,
      detail: null,
    };
  }

  if (options.token === undefined || options.token === null || options.token === '') {
    return {
      ok: true,
      detail:
        'the compute profile is on, so a real encode is expected, but this run has no ' +
        'runtime session token and therefore could not attempt one. Only /health and ' +
        '/health/ready were established — this is NOT the full proof. A Cloudflare API ' +
        'token authorises the tooling and cannot stand in for a user session, so proving ' +
        'a real encode is a manual step, recorded as a `not-run` row in ' +
        'docs/evidence/current.json.',
    };
  }

  const timeoutMs = options.timeoutMs ?? JOB_VERIFY_TIMEOUT_MS;
  const created = await requestJson(
    doFetch,
    `${target.origin}/api/jobs`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.token}`,
        [IDEMPOTENCY_KEY_HEADER]: options.idempotencyKey ?? randomUUID(),
      },
      body: JSON.stringify({ fixture: 'sample-v1', preset: 'demo-180p-v1' }),
      signal: AbortSignal.timeout(timeoutMs),
    },
    timeoutMs,
  );

  if (created.status !== 202) {
    return {
      ok: false,
      detail:
        `The release is healthy but a verification encode was not admitted: POST /api/jobs ` +
        `answered ${String(created.status)}${created.problem === null ? '' : ` (${created.problem})`}. ` +
        'A release whose compute path cannot admit a job is not verified.',
    };
  }

  const jobId = readString(created.body, 'id');
  if (jobId === null) {
    return {
      ok: false,
      detail: 'POST /api/jobs answered 202 without a job id, so there is nothing to poll.',
    };
  }

  const deadline = Date.now() + timeoutMs;
  let status: string | null = null;

  while (Date.now() < deadline) {
    const polled = await requestJson(
      doFetch,
      `${target.origin}/api/jobs/${encodeURIComponent(jobId)}`,
      {
        headers: { authorization: `Bearer ${options.token}` },
        signal: AbortSignal.timeout(10_000),
      },
      10_000,
    );

    if (polled.problem !== null || polled.status !== 200) {
      return {
        ok: false,
        detail: `The verification job ${jobId} could not be read: ${polled.problem ?? `status ${String(polled.status)}`}.`,
      };
    }

    status = readString(polled.body, 'status');

    if (status === 'succeeded' || status === 'failed') {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
  }

  if (status !== 'succeeded') {
    return {
      ok: false,
      detail:
        `The verification job ${jobId} ended as "${status ?? 'still pending'}" after ${timeoutMs}ms. ` +
        'A release that cannot complete one tiny encode is not verified.',
    };
  }

  // Bounded and caught.
  //
  // A rejected fetch or a body read that never finishes used to propagate out of
  // `apply` entirely: the deploy had already succeeded, and the operator saw a stack
  // trace instead of a failed release. Both outcomes now return a failed
  // verification, which is what a verification is for.
  let bytes: ArrayBuffer;
  try {
    const output = await doFetch(`${target.origin}/api/jobs/${encodeURIComponent(jobId)}/output`, {
      headers: { authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!output.ok) {
      return {
        ok: false,
        detail:
          `The verification job ${jobId} reported success but its output answered ${String(output.status)}. ` +
          'A successful status with no retrievable bytes is the failure this check exists for.',
      };
    }

    bytes = await output.arrayBuffer();
  } catch (error) {
    return {
      ok: false,
      detail: `The output of verification job ${jobId} could not be read: ${
        error instanceof Error ? error.message : 'network error'
      }. The release is live but its compute output is unproven.`,
    };
  }

  if (bytes.byteLength === 0) {
    // Its own message. "0 bytes were fetched" reads as a successful fetch of nothing,
    // which is the opposite of what an empty output means.
    return {
      ok: false,
      detail:
        `The output of verification job ${jobId} was empty. The job reported success and ` +
        'produced no bytes, which is a failure rather than a result.',
    };
  }

  return {
    ok: true,
    detail: `verification job ${jobId} succeeded and ${bytes.byteLength} bytes were fetched`,
  };
};

/** How long one verification encode may take before the release is not verified. */
export const JOB_VERIFY_TIMEOUT_MS = 180_000;

/** How often the verification job is polled. Bounded; not a busy loop. */
export const JOB_POLL_INTERVAL_MS = 3_000;

const requestJson = async (
  doFetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: Record<string, unknown> | null; problem: string | null }> => {
  let response: Response;
  try {
    response = await doFetch(url, init);
  } catch (error) {
    return {
      status: 0,
      body: null,
      problem: error instanceof Error ? error.message : 'network error',
    };
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = null;
  }

  void timeoutMs;
  return { status: response.status, body, problem: null };
};

const buildRecord = (
  target: ResolvedTarget,
  artifact: ArtifactCheck,
  smokeResult: SmokeResult,
  recordedAt: string,
  options: ApplyOptions,
  components: readonly MutatedComponent[],
): ReleaseRecord => {
  const revision = sourceRevision(options.root);
  // Asked for only after a successful deploy: `deployments list` on a Worker that
  // was never deployed answers nothing useful, and a record is not written on that
  // path anyway.
  const identity = deploymentIdentity(target, options.capture ?? captureWrangler);
  return {
    project: target.project,
    environment: target.environment,
    accountId: target.accountId,
    workerName: target.workerName,
    origin: target.origin,
    sourceSha: revision.sha,
    // Non-null because `inspectArtifact` refuses an absent artifact, so a record
    // can never claim a release of something that was not hashed.
    artifactDigest: artifact.digest ?? 'sha256:unavailable',
    deploymentId: identity.deploymentId,
    versionId: identity.versionId,
    recordedAt,
    smoke: smokeResult,
    skipMigrations: options.skipMigrations === true,
    components: components.map((component) => ({ ...component })),
    compute: target.compute.enabled
      ? {
          enabled: true,
          jobsWorkerName: target.compute.jobsWorkerName,
          mediaBucketName: target.compute.mediaBucketName,
          encodeWorkflowName: target.compute.encodeWorkflowName,
          maintenanceWorkflowName: target.compute.maintenanceWorkflowName,
          imageProtocol: target.compute.imageProtocol,
          containerProfile: target.compute.containerProfile,
          // What the committed jobs configuration declares, which is the only
          // offline answer available. Whether a run has actually happened is a
          // question about D1, not about this record.
          scheduleConfigured: true,
        }
      : null,
    nativeApiOrigin: target.nativeApiOrigin,
    schemaRevision:
      target.deploymentProfile === 'supabase' ? supabaseSchemaRevision(options.root) : null,
    verificationStatus: smokeResult.ok ? 'verified' : 'failed',
    ...(target.deploymentProfile === 'supabase' && target.supabase !== null
      ? {
          providerTargets: {
            supabaseProjectRef: target.supabase.projectRef,
            googleProjectId: target.supabase.googleProjectId,
            googleRegion: target.supabase.googleRegion,
            cloudRunJobName: target.supabase.jobName,
            image: target.supabase.image,
            protocol: target.supabase.protocol,
            r2Bucket: target.compute.mediaBucketName,
            nativeApiOrigin: target.nativeApiOrigin,
          },
        }
      : {}),
  };
};

/** Render an apply pipeline for a person. */
export const renderApply = (result: ApplyResult): string => {
  const lines = [''];
  for (const outcome of result.outcomes) {
    lines.push(`  ${outcome.ok ? 'ok  ' : 'FAIL'} ${outcome.phase.padEnd(8)} ${outcome.detail}`);
  }
  if (result.components.length > 0) {
    lines.push('', 'Mutated:');
    for (const component of result.components) {
      lines.push(
        `  ${component.phase.padEnd(8)} ${component.identity}` +
          `${component.protocol === undefined || component.protocol === null ? '' : ` [${component.protocol}]`}`,
      );
    }
  }
  if (result.stoppedAt !== null) {
    lines.push('', `Stopped at: ${result.stoppedAt}. See the detail above for what to do next.`);
  }
  return lines.join('\n');
};
