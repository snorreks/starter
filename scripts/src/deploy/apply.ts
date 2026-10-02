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

import { join } from 'node:path';
import { captureWrangler, runWrangler } from '../cloudflare/wrangler.ts';
import { planMigrate } from '../db/migrate.ts';
import { CLIENT_DIR, REPO_ROOT } from '../shared/paths.ts';
import { wranglerDatabaseId } from './configure.ts';
import {
  type ArtifactCheck,
  inspectArtifact,
  type ReleaseRecord,
  type SmokeResult,
  sourceRevision,
  writeReleaseRecord,
} from './release.ts';
import type { ResolvedTarget } from './target.ts';

/** Where the built Worker and its assets live. */
export const BUILD_DIR = join(CLIENT_DIR, '.svelte-kit', 'cloudflare');

/** The endpoint that proves release identity. Public, and safe to fetch. */
export const HEALTH_PATH = '/health';

export type Phase = 'build' | 'validate' | 'migrate' | 'deploy' | 'verify' | 'record';

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
  /** Present when the pipeline stopped early. */
  stoppedAt: Phase | null;
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
  /** Fetch the release for verification. Injected so failures are reachable. */
  fetch?: typeof globalThis.fetch;
  /** Read-only wrangler capture, for the provider's deployment identity. */
  capture?: (args: readonly string[]) => { ok: boolean; stdout: string; stderr: string };
  root?: string;
  /** Skip migrations. Explicit, and recorded in the release record. */
  skipMigrations?: boolean;
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
  const plan = planMigrate(target.environment, { databaseId: target.d1DatabaseId });

  if (!plan.ok) {
    return {
      ok: false,
      detail: `Refusing to deploy without migrating: ${plan.reason} ${plan.remedy}`,
    };
  }

  const configured = wranglerDatabaseId(target.environment, root);
  if (configured !== target.d1DatabaseId) {
    // Migrating one database and deploying code that reads another is invisible in
    // the argv: both commands name the binding `DB`, so only the configured id
    // reveals it. Refused before anything runs.
    return {
      ok: false,
      detail:
        `The ${target.environment} D1 database in wrangler.jsonc is ` +
        `${configured === null ? 'not configured' : `"${configured}"`}, but this project ` +
        `is configured with ${target.d1DatabaseId}.\n` +
        '  Wrangler resolves the database from its own config, so migrating now would move\n' +
        '  a different database than the deployment expects. Nothing has been changed.\n' +
        `  bun run deploy:configure -- --env ${target.environment} --provision`,
    };
  }

  return {
    ok: true,
    args: plan.args,
    description: `Apply reviewed migrations to ${target.d1DatabaseId} (${target.environment})`,
  };
};

/** The deploy argv for one environment, carrying the release identity. */
export const deployStep = (
  target: ResolvedTarget,
  sourceSha: string,
  digest: string | null,
): { description: string; args: string[] } => ({
  description: `Deploy ${target.workerName} and its assets to ${target.origin}`,
  args: [
    'deploy',
    '--env',
    target.environment,
    // The Worker name is passed explicitly rather than read from the config, so
    // the name the plan printed is the name that gets deployed.
    '--name',
    target.workerName,
    '--config',
    join(CLIENT_DIR, 'wrangler.jsonc'),
    // RELEASE is a git SHA: public information by construction, which is why it is
    // safe as a var and why /health can report it. It is what lets verification
    // prove *which* release is answering rather than merely that something is.
    '--var',
    `RELEASE:${sourceSha}`,
    // The digest travels with the release as metadata. Wrangler records it, and it
    // is what makes the recorded artifact independently checkable against the
    // provider.
    '--meta',
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
 * Fetch `/health` and report what the release says it is.
 *
 * The response body is *not* retained. `/health` is public by design, but a
 * release record outlives the deployment, and a record that can contain whatever
 * an origin chose to return is a record that eventually contains something
 * sensitive. Only the status and the reported release id are kept.
 */
export const smoke = async (
  target: ResolvedTarget,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
  options: { expectedRelease?: string; timeoutMs?: number } = {},
): Promise<SmokeResult> => {
  const url = `${target.origin}${HEALTH_PATH}`;
  const expected = options.expectedRelease;
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;

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
      ok: false,
      path: HEALTH_PATH,
      status: null,
      reportedRelease: null,
      problem: `Could not reach ${HEALTH_PATH}: ${error instanceof Error ? error.message : 'network error'}`,
    };
  }

  let reportedRelease: string | null = null;
  try {
    const body: unknown = await response.json();
    if (body !== null && typeof body === 'object' && 'release' in body) {
      const value = (body as { release: unknown }).release;
      if (typeof value === 'string') {
        reportedRelease = value;
      }
    }
  } catch {
    // A non-JSON body is a failed verification, not a crash: an HTML error page
    // from a misconfigured origin is precisely the failure worth reporting.
    reportedRelease = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      path: HEALTH_PATH,
      status: response.status,
      reportedRelease,
      problem: `${HEALTH_PATH} answered ${response.status}`,
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
      status: response.status,
      reportedRelease: null,
      problem:
        `${HEALTH_PATH} answered ${response.status} without identifying a release. ` +
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
      status: response.status,
      reportedRelease,
      problem:
        `/health reports release "${reportedRelease ?? 'none'}" but this deploy published ` +
        `"${expected}".`,
    };
  }

  return { ok: true, path: HEALTH_PATH, status: response.status, reportedRelease, problem: null };
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
 * Exported rather than inlined because it is useful *after* a pipeline that
 * already recorded: `verify` needs the same answer without re-running a deploy.
 * `wrangler deployments list` is read-only. A provider that reports no id yields
 * `null`, which the record renders as "not reported" — different from claiming an
 * id nobody can check.
 */
export const deploymentIdentity = (
  target: ResolvedTarget,
  capture: (args: readonly string[]) => { ok: boolean; stdout: string; stderr: string },
): { deploymentId: string | null; versionId: string | null } => {
  const result = capture(['deployments', 'list', '--name', target.workerName, '--json']);
  if (!result.ok) {
    return { deploymentId: null, versionId: null };
  }

  const pick = (key: string): string | null => {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(result.stdout);
    return match?.[1] ?? null;
  };

  return { deploymentId: pick('id'), versionId: pick('version_id') ?? pick('deployment_id') };
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
  // Both branches annotated rather than inferred: the fallback arrow has no
  // contextual type of its own, so without them `run` becomes a union of two
  // differently-typed callables and every call site below reports "not callable".
  const run: (command: string, args: readonly string[], options: { cwd: string }) => number =
    options.run ?? ((_command, args, runOptions) => runWrangler(args, runOptions));
  const inspect = options.inspect ?? ((): ArtifactCheck => inspectArtifact(BUILD_DIR));
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? ((): string => new Date().toISOString());

  const outcomes: StepOutcome[] = [];
  const argv: string[][] = [];

  // `detail` is accepted and deliberately unused here: the reason is already in
  // `outcomes`, and printing it twice would give the same sentence two sources of
  // truth. The parameter stays so every refusal reads the same at the call site.
  const stop = (_phase: Phase, _detail: string): ApplyResult => ({
    ok: false,
    outcomes,
    argv,
    record: null,
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

  // ── build ──────────────────────────────────────────────────────────────────
  if (options.build !== undefined) {
    const built = options.build();
    if (!built.ok) {
      const detail = `The build failed: ${built.detail}`;
      outcomes.push(bad('build', detail));
      return stop('build', detail);
    }
    outcomes.push(ok('build', built.detail));
  }

  // ── validate ───────────────────────────────────────────────────────────────
  const artifact = inspect();
  if (!artifact.ok) {
    const problems = artifact.problems.join(' ');
    outcomes.push(bad('validate', problems));
    return stop('validate', problems);
  }
  outcomes.push(ok('validate', `${artifact.fileCount} files, digest ${artifact.digest}`));

  // ── migrate ────────────────────────────────────────────────────────────────
  if (options.skipMigrations === true) {
    outcomes.push(
      ok('migrate', 'skipped by request; the schema is whatever the last apply left behind'),
    );
  } else {
    const migrated = migrate(target, argv, options.root ?? REPO_ROOT);
    if (!migrated.ok) {
      outcomes.push(bad('migrate', migrated.detail));
      return stop('migrate', migrated.detail);
    }
    const code = run('wrangler', argv[argv.length - 1] as string[], { cwd: CLIENT_DIR });
    if (code !== 0) {
      const detail =
        `Migration failed with exit code ${code}. The schema may be partly applied; ` +
        're-running `apply` is safe, because D1 records each migration in its journal ' +
        'and re-applies only what is missing.';
      outcomes.push(bad('migrate', detail));
      return stop('migrate', detail);
    }
    outcomes.push(ok('migrate', migrated.detail));
  }

  // ── deploy ─────────────────────────────────────────────────────────────────
  const revision = sourceRevision(options.root);
  const deployArgs = [
    'deploy',
    '--env',
    target.environment,
    '--name',
    target.workerName,
    '--config',
    join(CLIENT_DIR, 'wrangler.jsonc'),
    // `RELEASE` is a git SHA: public information by construction, which is why it
    // is safe as a var and why `/health` can report it. It is what lets a verify
    // step prove *which* release is answering rather than merely that something is.
    '--var',
    `RELEASE:${revision.sha}`,
    // The digest travels with the release as metadata. Wrangler records it, and it
    // is what makes the recorded artifact independently checkable against the
    // provider.
    '--meta',
    `source_sha=${revision.sha},artifact=${artifact.digest ?? 'unknown'}`,
  ];
  argv.push(deployArgs);

  const deployCode = run('wrangler', deployArgs, { cwd: CLIENT_DIR });
  if (deployCode !== 0) {
    const detail =
      `Deploy failed with exit code ${deployCode}. The schema is ahead of the running ` +
      'code, which is why a rollback does not roll the schema back: see the recovery ' +
      'procedure in docs/deployment.md.';
    outcomes.push(bad('deploy', detail));
    return stop('deploy', detail);
  }
  outcomes.push(ok('deploy', `${target.workerName} deployed to ${target.origin}`));

  // ── verify ─────────────────────────────────────────────────────────────────
  // The expected release is this run's own SHA: verification asks "is the thing I
  // just published answering?", not "is anything answering?".
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
    const record = buildRecord(target, artifact, smokeResult, now(), options);
    writeReleaseRecord(record, options.root);
    outcomes.push(ok('record', 'recorded despite the failed verification'));
    return { ok: false, outcomes, argv, record, stoppedAt: 'verify' };
  }
  outcomes.push(
    ok(
      'verify',
      `${smokeResult.path} -> ${smokeResult.status}, release ${smokeResult.reportedRelease ?? 'unreported'}`,
    ),
  );

  // ── record ─────────────────────────────────────────────────────────────────
  const record = buildRecord(target, artifact, smokeResult, now(), options);
  writeReleaseRecord(record, options.root);
  outcomes.push(ok('record', `wrote ${target.environment} release record`));

  return { ok: true, outcomes, argv, record, stoppedAt: null };
};

const buildRecord = (
  target: ResolvedTarget,
  artifact: ArtifactCheck,
  smokeResult: SmokeResult,
  recordedAt: string,
  options: ApplyOptions,
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
  };
};

/** Render an apply pipeline for a person. */
export const renderApply = (result: ApplyResult): string => {
  const lines = [''];
  for (const outcome of result.outcomes) {
    lines.push(`  ${outcome.ok ? 'ok  ' : 'FAIL'} ${outcome.phase.padEnd(8)} ${outcome.detail}`);
  }
  if (result.stoppedAt !== null) {
    lines.push('', `Stopped at: ${result.stoppedAt}. See the detail above for what to do next.`);
  }
  return lines.join('\n');
};
