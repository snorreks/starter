// scripts/src/deploy/deploy.ts
//
// The deployment CLI, as five separate phases.
//
//   bun run deploy plan      --env staging          # offline. No credential, no network.
//   bun run deploy preflight --env staging          # authenticated, read-only.
//   bun run deploy apply     --env staging --yes    # build, migrate, deploy, verify, record.
//   bun run deploy verify   --env staging           # ask the release what it is.
//   bun run deploy status                           # what is recorded, and what is configured.
//
// They are five commands rather than five flags because they have different
// authority. `plan` must be runnable on a fork's pull request with no secret and
// no network, which is only true if it cannot reach an authenticated code path.
// `preflight` may read the account but must never change it. Only `apply` mutates,
// and only with `--yes`.
//
// The separation this command preserves: **building, migrating and deploying are
// three different things.** A build does not deploy. A migration does not deploy.
// A deploy does not migrate — `apply` does both, in that order, because the new
// code must never meet the old schema, and it refuses rather than deploying when
// the migration cannot be planned.
//
// There is exactly one target. The application deploys as one Worker plus its
// static assets, so there is one `wrangler deploy` per environment. The old
// two-target form (`web`/`api`) cost something real: a partial deploy in which the
// Worker succeeded and the assets did not leaves a live deployment whose pages
// 404, and nothing in the plan could express that as a state to avoid.
//
// Three things this file is strict about, because each was previously a way to
// change something nobody asked for:
//
//   * `wrangler` appears in argv exactly once. `Step.args` holds the subcommand
//     and its flags only; the runner supplies the binary.
//   * An unrecognised phase or environment is an error, not a no-op.
//   * An unknown flag is an error, and a boolean flag written as `--flag=value`
//     is an error naming the mistake.

import { spawnSync } from 'node:child_process';
import { isDeploymentEnvironment } from '@starter/schemas';
import { runWrangler, setProcessRunner, wranglerAvailable } from '../cloudflare/wrangler.ts';
import {
  type DeploymentValues,
  effectiveDeploymentValues,
  LOCAL_DEPLOYMENT_FILE,
} from '../registry/deployment_values.ts';
import { EXIT, fail, wantsHelp } from '../shared/command.ts';
import { CLIENT_DIR, REPO_ROOT } from '../shared/paths.ts';
import {
  type ApplyResult,
  apply,
  deployStep,
  HEALTH_PATH,
  migrationStep,
  renderApply,
} from './apply.ts';
import { hasApiToken, secretInArgvProblem } from './credentials.ts';
import { preflight, renderPreflight } from './preflight.ts';
import {
  type ReleaseRecord,
  readReleaseRecord,
  renderReleaseRecord,
  sourceRevision,
} from './release.ts';
import {
  DEPLOYABLE_ENVIRONMENTS,
  environmentIsolationProblem,
  type ResolvedTarget,
  resolveTarget,
  suggestOrigin,
} from './target.ts';

export const DEPLOY_PHASES = ['plan', 'preflight', 'apply', 'verify', 'status'] as const;
export type DeployPhase = (typeof DEPLOY_PHASES)[number];

export interface Step {
  description: string;
  command: string;
  /** Wrangler subcommand and flags. Deliberately excludes the `wrangler` token. */
  args: string[];
  cwd: string;
  /** Requires a remote mutation, so it needs explicit consent. */
  remote: boolean;
}

export type Plan =
  | { ok: true; steps: Step[]; target: ResolvedTarget; notices: string[] }
  | { ok: false; reason: string; remedy: string };

export { EXIT } from '../shared/command.ts';

const VALUE_FLAGS = new Set(['--env']);
const BOOLEAN_FLAGS = new Set([
  '--yes',
  '--dry-run',
  '--json',
  '--allow-new-worker',
  '--skip-migrations',
  '--help',
  '-h',
]);

export type ArgvResult =
  | {
      ok: true;
      phase: DeployPhase;
      environment: 'staging' | 'production' | null;
      yes: boolean;
      json: boolean;
      dryRun: boolean;
      allowNewWorker: boolean;
      skipMigrations: boolean;
      help: boolean;
    }
  | { ok: false; errors: string[] };

/**
 * Parse argv strictly.
 *
 * Every token must be accounted for. The previous implementation filtered argv
 * down to tokens that happened to be valid targets and defaulted to "both" when
 * nothing survived, so a typo silently widened the blast radius.
 *
 * Defaults, all of which are *absences of input* rather than mistakes:
 *   * no phase        -> `apply`, which is what `bun run deploy -- --yes` asks for
 *   * no `--env`      -> `staging`, the safe direction for a live-mutating command
 *   * no phase and no
 *     `--yes`         -> still `apply`; `apply` then refuses, loudly, with no
 *                        further argument needed
 */
export const parseDeployArgs = (argv: readonly string[]): ArgvResult => {
  const errors: string[] = [];
  let phase: DeployPhase | null = null;
  const phasesSeen: string[] = [];
  let environment: string | null = null;
  /** Every `--env` value seen, to catch two different ones. */
  const explicitEnvironments: string[] = [];
  let yes = false;
  let json = false;
  let dryRun = false;
  let allowNewWorker = false;
  let skipMigrations = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === undefined) {
      continue;
    }

    if (!token.startsWith('-')) {
      if (!(DEPLOY_PHASES as readonly string[]).includes(token)) {
        errors.push(
          `Unknown phase "${token}". Phases: ${DEPLOY_PHASES.join(', ')}.\n` +
            '  The old `web` target word is gone: this project deploys as one Worker, so ' +
            'there is one thing to name and `bun run deploy apply` is what replaces it.',
        );
        continue;
      }
      phasesSeen.push(token);
      phase = token as DeployPhase;
      continue;
    }

    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      index += 1;

      if (value === undefined) {
        errors.push('--env needs a value: staging or production.');
        continue;
      }

      explicitEnvironments.push(value);

      if (value === 'local') {
        errors.push(
          '--env local is not a deployment target. This command deploys to a remote ' +
            'Cloudflare environment. For local workerd, use `bun run dev` — that is a ' +
            'different thing from running this command on your own machine.',
        );
        continue;
      }

      if (!isDeploymentEnvironment(value)) {
        errors.push(
          `--env must be ${DEPLOYABLE_ENVIRONMENTS.join(' or ')} (got "${value}"). ` +
            'Refusing rather than defaulting: "--env prod" resolving to production is the ' +
            'kind of silent widening this parser exists to prevent.',
        );
        continue;
      }

      environment = value;
      continue;
    }

    // Matched against the whole token, not the part before `=`. Splitting first
    // meant `--dry-run=false` set `dryRun = true` — the opposite of what was
    // written — while `--yes=false` granted the consent it appears to name.
    if (BOOLEAN_FLAGS.has(token)) {
      if (token === '--yes') {
        yes = true;
      }
      if (token === '--json') {
        json = true;
      }
      if (token === '--dry-run') {
        dryRun = true;
      }
      if (token === '--allow-new-worker') {
        allowNewWorker = true;
      }
      if (token === '--skip-migrations') {
        skipMigrations = true;
      }
      if (token === '--help' || token === '-h') {
        help = true;
      }
      continue;
    }

    if (token.includes('=')) {
      const name = token.split('=', 2)[0] as string;
      const inline = token.slice(name.length + 1);
      // Named rather than "Unknown flag": the writer's mistake is the *form*, and
      // saying so is the difference between a fixable error and a puzzle.
      if (BOOLEAN_FLAGS.has(name)) {
        errors.push(
          `"${name}" is a flag, not a key=value pair. Pass "${name}" on its own, without a value.`,
        );
      } else if (VALUE_FLAGS.has(name)) {
        errors.push(
          `"${name}" takes its value as a separate argument, not after "=":` +
            ` pass "${name} ${inline}".`,
        );
      } else {
        errors.push(`Unknown flag "${name}". Run with --help.`);
      }
      continue;
    }

    errors.push(`Unknown flag "${token}". Run with --help.`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  if (new Set(phasesSeen).size > 1) {
    return {
      ok: false,
      errors: [`Conflicting phases: ${[...new Set(phasesSeen)].join(', ')}. Pick one.`],
    };
  }

  // `--env staging --env staging` is not ambiguous and is harmless;
  // `--env staging --env production` is a question with two answers, and the
  // second one silently winning would deploy to whichever the parser kept.
  if (new Set(explicitEnvironments).size > 1) {
    return {
      ok: false,
      errors: [`Conflicting --env values: ${[...new Set(explicitEnvironments)].join(', ')}.`],
    };
  }

  return {
    ok: true,
    // Defaulting to `apply` preserves `bun run deploy -- --env staging --yes`, which
    // is the documented invocation in docs/cloudflare.md and the one an operator
    // types expecting a deploy.
    phase: phase ?? 'apply',
    environment: environment === null ? null : (environment as 'staging' | 'production'),
    yes,
    json,
    dryRun,
    allowNewWorker,
    skipMigrations,
    help,
  };
};

export const usageText = (): string =>
  [
    'Usage: bun run deploy <phase> [flags]',
    '',
    'Phases:',
    '  plan        Print what would happen. Offline: no credential, no network, no change.',
    '  preflight   Authenticated and READ-ONLY: account, database and Worker exist and match.',
    '  apply       build -> migrate -> deploy -> verify -> record. Requires --yes.',
    '  verify      Fetch the release and report the identity it claims.',
    '  status      What is configured and what release is recorded. Read-only.',
    '',
    'Flags:',
    '  --env staging|production   Which environment. Default: staging.',
    '  --yes                      Required by `apply`. Nothing is mutated without it.',
    '  --json                     Machine-readable output.',
    '  --dry-run                  Same as `plan`.',
    '  --allow-new-worker         preflight: a first deploy has no Worker yet; accept that.',
    '  --skip-migrations          apply: deploy without migrating. Recorded in the release.',
    '  --help                     This text.',
    '',
    'Notes:',
    '  No phase defaults to `apply`. `--env local` is refused; local workerd is `bun run dev`.',
    '  The credential is CLOUDFLARE_API_TOKEN in the environment. Never on a command line.',
  ].join('\n');

/**
 * Build the offline plan without executing anything.
 *
 * Offline by construction: it resolves configuration and refuses, and touches
 * neither a credential nor a network. That is what lets `plan` run on a fork's
 * pull request, where there is no secret to give it.
 *
 * `values` and `buildDir` are parameters so the whole thing is assertable without
 * a provisioned repository.
 */
export const planDeploy = (
  environment: string,
  options: {
    values?: DeploymentValues;
    buildDir?: string;
    hasCredential?: boolean;
    requireArtifact?: boolean;
    root?: string;
  } = {},
): Plan => {
  const resolved = resolveTarget(environment, {
    values: options.values ?? effectiveDeploymentValues(),
  });

  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason, remedy: resolved.remedy };
  }

  const target = resolved.target;
  const revision = sourceRevision(options.root);

  // Built from the same functions `apply` executes. The hand-written copies these
  // replaced had already drifted: the plan's migration omitted `--remote` and its
  // deploy omitted `--var RELEASE` and `--meta`. A dry run that renders different
  // argv from the real run is a dry run that can lie, which is the whole claim
  // being tested.
  const migration = migrationStep(target, options.root ?? REPO_ROOT);
  if (!migration.ok) {
    return { ok: false, reason: migration.detail, remedy: 'Fix the migration plan, then re-run.' };
  }

  const notices: string[] = [];

  const steps: Step[] = [
    {
      description: migration.description,
      command: 'wrangler',
      args: migration.args,
      cwd: CLIENT_DIR,
      remote: true,
    },
    {
      description: deployStep(target, revision.sha, null).description,
      command: 'wrangler',
      args: deployStep(target, revision.sha, null).args,
      cwd: CLIENT_DIR,
      remote: true,
    },
    {
      description: `Verify the release at ${target.origin}${HEALTH_PATH}`,
      command: 'fetch',
      args: [`${target.origin}${HEALTH_PATH}`],
      cwd: CLIENT_DIR,
      remote: true,
    },
  ];

  notices.push(
    `Secrets required (names only, from the config): ${target.requiredSecretNames.join(', ')}.`,
  );
  notices.push(
    `Nonsecret vars required: ${target.requiredVarNames.join(', ')}. Set them through ` +
      "wrangler.jsonc's environment vars, never through the secret channel.",
  );
  notices.push(
    'A code rollback does not roll back the schema. See the recovery procedure in ' +
      'docs/deployment.md before rolling back an environment whose migrations ran.',
  );
  if (target.environment === 'production') {
    notices.push('A production apply changes live traffic.');
  }

  const credentialed = options.hasCredential ?? hasApiToken();
  if (!credentialed) {
    notices.push(
      'No credential is present, so this plan cannot be executed here. That is expected: ' +
        'plan needs none, and `preflight` is where a credential is first required.',
    );
  }

  return { ok: true, steps, target, notices };
};

/**
 * Render a built plan for a person, with the resolved destination spelled out.
 *
 * The destination block is above the commands because the question "what would this
 * change?" is answered by the Worker name, the account and the origin — not by a
 * list of subcommands that look the same for every environment.
 */
export const renderPlan = (plan: Extract<Plan, { ok: true }>): string => {
  const target = plan.target;
  const lines = [
    `Deploy plan (${target.environment})`,
    '',
    `  project     ${target.project}`,
    `  account     ${target.accountId}`,
    `  worker      ${target.workerName}`,
    `  database    ${target.d1DatabaseId}`,
    `  origin      ${target.origin}`,
    `  config      ${target.wranglerConfig}`,
    '',
    'Commands:',
  ];

  for (const [index, step] of plan.steps.entries()) {
    lines.push(`  ${index + 1}. ${step.description}`);
    lines.push(`     ${step.command} ${step.args.join(' ')}`);
  }

  if (plan.notices.length > 0) {
    lines.push('', 'Notes:');
    for (const notice of plan.notices) {
      lines.push(`  - ${notice}`);
    }
  }

  return lines.join('\n');
};

const readValues = (): DeploymentValues => effectiveDeploymentValues();

/**
 * Run a `bun` subcommand through the bounded runner, returning its exit code.
 *
 * The same mechanism every other subprocess here uses. A build that ran
 * *outside* it would be a build with no bound on its output and no exit status
 * to check, which is the "command that succeeds while doing nothing" this
 * repository treats as the worst outcome.
 */
const runBun = (args: readonly string[], cwd: string): number =>
  // `bun` by name: it is the interpreter already running this process, so it is
  // on PATH by definition and there is nothing to resolve.
  spawnSync('bun', [...args], { stdio: 'inherit', cwd }).status ?? 1;

/**
 * `status`: what is configured, and what was last released.
 *
 * Read-only and offline. It reports the layer that answered for each value, so a
 * stale gitignored overlay is visible rather than something to discover later.
 */
const runStatus = (json: boolean): number => {
  const isolation = environmentIsolationProblem(readValues());
  const configured = DEPLOYABLE_ENVIRONMENTS.map((environment) => ({
    environment,
    resolved: resolveTarget(environment, { values: readValues() }),
  }));

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          isolation,
          environments: configured.map(({ environment, resolved }) => ({
            environment,
            configured: resolved.ok,
            problem: resolved.ok ? null : resolved.reason,
            target: resolved.ok ? resolved.target : null,
            release: readReleaseRecord(environment),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return isolation === null ? EXIT.ok : EXIT.failed;
  }

  process.stdout.write('Deployment status\n\n');

  if (isolation !== null) {
    process.stdout.write(`  REFUSED  ${isolation}\n`);
  }

  for (const { environment, resolved } of configured) {
    if (resolved.ok) {
      const target = resolved.target;
      process.stdout.write(`  ok       ${environment}: ${target.workerName} -> ${target.origin}\n`);
      process.stdout.write(
        `           account ${target.accountId}, database ${target.d1DatabaseId}\n`,
      );
    } else {
      process.stdout.write(`  missing  ${environment}: ${resolved.reason}\n`);
    }

    const record = readReleaseRecord(environment);
    process.stdout.write(
      record === null
        ? `           no release recorded. Origin would be ${suggestOrigin('<worker>')}\n`
        : `           last release ${record.sourceSha.slice(0, 12)} / ${record.artifactDigest.slice(0, 19)}\n`,
    );
  }

  process.stdout.write(
    `\nConfiguration lives in ${LOCAL_DEPLOYMENT_FILE} (gitignored). Account ids, ` +
      'Worker names, database ids and origins are configuration, not secrets.\n',
  );

  return isolation === null ? EXIT.ok : EXIT.failed;
};

/**
 * The CLI adapter.
 *
 * Parsing, phase routing and exit codes only. The work is in `target.ts`,
 * `preflight.ts` and `apply.ts`, which is what lets the whole surface be asserted
 * without spawning anything.
 */
export const main = async (argv: readonly string[]): Promise<number> => {
  const parsed = parseDeployArgs(argv);

  if (!parsed.ok) {
    return fail(`${parsed.errors.join('\n')}\n\n${usageText()}`, EXIT.usage);
  }

  if (parsed.help || wantsHelp(argv)) {
    process.stdout.write(`${usageText()}\n`);
    return EXIT.ok;
  }

  // Refused before anything is built, so an argv that would leak a credential
  // cannot reach the point of leaking it — not even in a dry run that renders it.
  const leak = secretInArgvProblem(argv);
  if (leak !== null) {
    return fail(leak, EXIT.refused);
  }

  // `status` is the one phase with no environment: it reports both.
  if (parsed.phase === 'status') {
    return runStatus(parsed.json);
  }

  const environment = parsed.environment ?? 'staging';

  // `--dry-run` means the plan, and it is honoured rather than parsed and ignored.
  // Ignoring it was a live defect: `deploy apply --env production --dry-run --yes`
  // took the apply path and deployed.
  if (parsed.dryRun && parsed.phase === 'apply') {
    // Refused rather than silently re-routed: someone who wrote both flags meant
    // one of them, and picking for them is how the wrong one gets deployed.
    return fail(
      '--dry-run means "print the plan and change nothing", so it cannot be combined\n' +
        '  with the apply phase. Run:\n' +
        '    bun run deploy plan --env ' +
        environment +
        '\n' +
        '    bun run deploy apply --env ' +
        environment +
        ' --yes    # to actually deploy',
      EXIT.usage,
    );
  }

  const phase: DeployPhase = parsed.dryRun ? 'plan' : parsed.phase;

  // ── plan ───────────────────────────────────────────────────────────────────
  if (phase === 'plan') {
    const plan = planDeploy(environment);
    if (!plan.ok) {
      return fail(`${plan.reason}\n${plan.remedy}`, EXIT.failed);
    }
    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify(
          { phase: 'plan', target: plan.target, steps: plan.steps, notices: plan.notices },
          null,
          2,
        )}\n`,
      );
      return EXIT.ok;
    }
    process.stdout.write(`${renderPlan(plan)}\n`);
    process.stdout.write('\nPlan only: nothing was changed.\n');
    return EXIT.ok;
  }

  // ── preflight ──────────────────────────────────────────────────────────────
  if (phase === 'preflight') {
    const resolved = resolveTarget(environment, { values: readValues() });
    if (!resolved.ok) {
      return fail(`${resolved.reason}\n${resolved.remedy}`, EXIT.failed);
    }

    if (!wranglerAvailable()) {
      return fail('wrangler is not available. Run `bun install` first.', EXIT.unavailable);
    }

    const report = preflight(resolved.target, { allowMissingWorker: parsed.allowNewWorker });

    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.ok ? EXIT.ok : EXIT.failed;
    }

    process.stdout.write(`${renderPreflight(resolved.target, report)}\n`);
    return report.ok ? EXIT.ok : EXIT.failed;
  }

  // ── verify ─────────────────────────────────────────────────────────────────
  if (phase === 'verify') {
    const resolved = resolveTarget(environment, { values: readValues() });
    if (!resolved.ok) {
      return fail(`${resolved.reason}\n${resolved.remedy}`, EXIT.failed);
    }

    const { smoke } = await import('./apply.ts');
    const result = await smoke(resolved.target);

    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? EXIT.ok : EXIT.failed;
    }

    if (!result.ok) {
      return fail(
        `Verification failed: ${result.problem ?? 'unknown'}\n  Deployed target: ${resolved.target.workerName} (${resolved.target.origin})`,
        EXIT.failed,
      );
    }

    // Both probes are named on success, because a verification that only mentioned
    // liveness reads as though readiness was never asked.
    process.stdout.write(
      `ok  ${result.path} -> ${result.status}, release ${result.reportedRelease ?? 'unreported'}\n` +
        `ok  ${result.readiness?.path ?? '/health/ready'} -> ${result.readiness?.status ?? 'unknown'} (ready)\n` +
        `    ${resolved.target.workerName} at ${resolved.target.origin}\n`,
    );
    return EXIT.ok;
  }

  // ── apply ──────────────────────────────────────────────────────────────────
  const resolved = resolveTarget(environment, { values: readValues() });
  if (!resolved.ok) {
    return fail(`${resolved.reason}\n${resolved.remedy}`, EXIT.failed);
  }

  if (!parsed.yes) {
    return fail(
      `Refusing to apply to ${resolved.target.environment} without --yes.\n` +
        '  Nothing has been changed. Run `bun run deploy plan --env ' +
        environment +
        '` to see exactly what would happen.',
      EXIT.refused,
    );
  }

  if (!wranglerAvailable()) {
    return fail('wrangler is not available. Run `bun install` first.', EXIT.unavailable);
  }

  const result: ApplyResult = await apply({
    target: resolved.target,
    consented: true,
    skipMigrations: parsed.skipMigrations,
    // The artifact is built here, from this checkout, rather than taken from
    // whatever `.svelte-kit/` happens to hold. Without this the deploy publishes
    // a previous run's bytes whenever they are newer than the source, and the
    // recorded SHA is then a SHA nothing was built from.
    build: () => {
      const built = runBun(['run', 'build'], REPO_ROOT);
      if (built !== 0) {
        return { ok: false, detail: `bun run build exited ${built}` };
      }
      const checked = runBun(['run', 'check:bundle'], REPO_ROOT);
      return checked === 0
        ? { ok: true, detail: 'built and validated from this checkout' }
        : { ok: false, detail: `bun run check:bundle exited ${checked}` };
    },
  });

  process.stdout.write(`${renderApply(result)}\n`);

  if (result.record !== null) {
    process.stdout.write(`\n${renderReleaseRecord(result.record)}\n`);
  }

  return result.ok ? EXIT.ok : EXIT.failed;
};

export { digestArtifact, inspectArtifact } from './release.ts';
export type { ReleaseRecord };
export { runWrangler, setProcessRunner };
