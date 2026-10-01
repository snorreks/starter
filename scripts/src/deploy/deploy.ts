// scripts/src/deploy/index.ts
//
// Deploy application code to Cloudflare Workers.
//
//   bun run deploy:check              # validate + print the plan. Mutates nothing.
//   bun run deploy -- --dry-run       # the same plan, printed
//   bun run deploy -- api --env staging --yes
//   bun run deploy -- client api --env production --yes
//
// The separation this command preserves: **build, source publication, resource
// provisioning and application deployment are four different things**, and this
// one only ever does the last. Publishing a repository does not deploy it.
// Creating a database does not deploy code. A deploy does not publish anything.
//
// Three things this file is strict about, because each was previously a way to
// change something nobody asked for:
//
//   * `wrangler` appears in argv exactly once. `Step.args` holds the subcommand
//     and its flags only; `runWrangler` supplies the binary.
//   * `--env local` is rejected. Running this CLI on a laptop is "a local
//     invocation" and has nothing to do with `--env local`, which would mean
//     "deploy to a local target" — a thing this command does not do. The local
//     *runtime* is `bun run dev:api` (`wrangler dev`).
//   * An unrecognised target word is an error, not a no-op. Filtering unknown
//     words out and defaulting to "both" turns `--app clientt` into a production
//     deploy of the wrong app.

import type { DeploymentEnvironment } from '@starter/schemas';
import {
  API_DIR,
  CLIENT_DIR,
  type ProcessRunner,
  requireRemoteConsent,
  runWrangler,
  setProcessRunner,
  wranglerAvailable,
} from '../cloudflare/wrangler.ts';
import { DEPLOYMENT_CONFIG } from '../registry/app_registry.ts';
import { type ConfigCheck, inspectConfig } from './configure.ts';

export type DeployTarget = 'api' | 'client';

export interface Step {
  target: DeployTarget;
  description: string;
  command: string;
  /** Wrangler subcommand and flags. Deliberately excludes the `wrangler` token. */
  args: string[];
  cwd: string;
  /** Requires a remote mutation, so it needs explicit consent. */
  remote: boolean;
}

export type Plan =
  | { ok: true; steps: Step[]; notices: string[] }
  | { ok: false; reason: string; remedy: string };

export const VALID_TARGETS: readonly DeployTarget[] = ['api', 'client'];
const VALID_ENVIRONMENTS: readonly DeploymentEnvironment[] = ['staging', 'production'];

/**
 * Exit codes, so a caller can distinguish "you typed it wrong" from "this project
 * is not configured" from "prerequisite unavailable" from "it deployed".
 *
 * The shared table rather than a local one: `unavailable` means "the tool is not
 * installed", and this module's own `notConfigured` was 1 — the same code the
 * commands use for "the work failed". A deploy that could not find wrangler
 * therefore reported failure indistinguishably from a step that failed, and the
 * two need different responses from a job.
 */
export { EXIT } from '../shared/command.ts';

/** Re-exported so this module's own returns have a name to resolve against. */
import { EXIT } from '../shared/command.ts';

/** Flags that take a value. Anything else must be a boolean flag or an error. */
const VALUE_FLAGS = new Set(['--env']);
const BOOLEAN_FLAGS = new Set(['--dry-run', '--yes', '--json', '--help', '-h']);

export type ArgvResult =
  | {
      ok: true;
      environment: DeploymentEnvironment;
      targets: DeployTarget[];
      dryRun: boolean;
      json: boolean;
      help: boolean;
    }
  | { ok: false; errors: string[] };

/**
 * Parse deploy argv strictly.
 *
 * Every token must be accounted for. The previous implementation filtered argv
 * down to tokens that happened to be valid targets and defaulted to "both" when
 * nothing survived, so a typo silently widened the blast radius.
 *
 * Defaults, both of which are *absences of input* rather than mistakes:
 *   * no `--env` at all -> `staging`, the safe direction for a live-mutating command
 *   * no target words at all -> both targets, which is what running `bun run deploy`
 *     with no arguments plainly asks for
 *
 * `--env local` is a mistake, not an absence: it is an explicit request for a
 * target this command does not have.
 */
export const parseDeployArgs = (argv: readonly string[]): ArgvResult => {
  const errors: string[] = [];
  const targets: DeployTarget[] = [];
  let environment: DeploymentEnvironment | null = null;
  /** Every `--env` value seen, to catch two different ones. */
  const explicitEnvironments: string[] = [];
  let dryRun = false;
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === undefined) {
      continue;
    }

    if (!token.startsWith('-')) {
      if (!VALID_TARGETS.includes(token as DeployTarget)) {
        errors.push(`Unknown target "${token}". Valid targets: ${VALID_TARGETS.join(', ')}.`);
        continue;
      }
      if (!targets.includes(token as DeployTarget)) {
        targets.push(token as DeployTarget);
      }
      continue;
    }

    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      index += 1;

      if (value !== undefined) {
        explicitEnvironments.push(value);
      }

      if (value === undefined) {
        errors.push('--env needs a value: staging or production.');
        continue;
      }

      if (value === 'local') {
        errors.push(
          '--env local is not a deployment target. This command deploys to a remote ' +
            'Cloudflare environment. For local workerd, use `bun run dev:api` ' +
            '(`wrangler dev`) — that is a different thing from running this command ' +
            'on your own machine.',
        );
        continue;
      }

      if (!VALID_ENVIRONMENTS.includes(value as DeploymentEnvironment)) {
        errors.push(
          `--env must be ${VALID_ENVIRONMENTS.join(' or ')} (got "${value}"). ` +
            'This command cannot deploy to a local target.',
        );
        continue;
      }

      environment = value as DeploymentEnvironment;
      continue;
    }

    // Matched against the whole token, not the part before `=`. Splitting first
    // meant `--dry-run=false` set `dryRun = true` — the opposite of what was
    // written — while `--yes=false` failed to grant the consent it appears to name.
    if (BOOLEAN_FLAGS.has(token)) {
      if (token === '--dry-run') {
        dryRun = true;
      }
      if (token === '--json') {
        json = true;
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

  // A duplicated `--env` with two different values is ambiguous. `--env staging
  // --env staging` is not, and is harmless.
  if (new Set(explicitEnvironments).size > 1) {
    return {
      ok: false,
      errors: [`Conflicting --env values: ${[...new Set(explicitEnvironments)].join(', ')}.`],
    };
  }

  return {
    ok: true,
    environment: environment ?? 'staging',
    targets: targets.length === 0 ? [...VALID_TARGETS] : targets,
    dryRun,
    json,
    help,
  };
};

export const usageText = (): string =>
  [
    'Usage: bun run deploy [targets] [flags]',
    '',
    'Targets:',
    '  api       the backend Worker',
    '  client    the static-assets Worker',
    '  (omit)    both',
    '',
    'Flags:',
    '  --env staging|production   Where to deploy. Default: staging.',
    '  --dry-run                  Print the plan and change nothing.',
    '  --json                     Emit the plan as JSON.',
    '  --yes                      Required to perform a remote mutation.',
    '  --help                     This text.',
    '',
    'Notes:',
    '  --env local is rejected. Local workerd is `bun run dev:api`.',
    '  A Cloudflare credential must be present as CLOUDFLARE_API_TOKEN.',
  ].join('\n');

/**
 * Build the deploy plan without executing anything.
 *
 * Exported so `--dry-run` and the test suite assert on the *same* plan. A dry run
 * that re-derives the commands is a dry run that can lie.
 *
 * `config` is injectable so the template's "nothing is provisioned" state does not
 * hide the contents of a plan from every assertion.
 */
export const planDeploy = (
  targets: readonly DeployTarget[],
  environment: DeploymentEnvironment,
  config: ConfigCheck = inspectConfig(),
): Plan => {
  for (const target of targets) {
    if (!VALID_TARGETS.includes(target)) {
      return {
        ok: false,
        reason: `"${target}" is not a deploy target.`,
        remedy: `Valid targets: ${VALID_TARGETS.join(', ')}.`,
      };
    }
  }

  if (!VALID_ENVIRONMENTS.includes(environment)) {
    return {
      ok: false,
      reason: `"${environment}" is not a deployable environment.`,
      remedy: `Environments: ${VALID_ENVIRONMENTS.join(', ')}. Use \`bun run dev:api\` for local workerd.`,
    };
  }

  if (!config.ok) {
    return {
      ok: false,
      reason: [
        'Cloudflare is not configured for this project yet.',
        ...(config.problems.length === 0
          ? []
          : ['', ...config.problems.map((problem) => `  - ${problem}`)]),
      ].join('\n'),
      remedy:
        '  bun run deploy:configure -- --provision   # create what is missing\n' +
        '  bun run deploy:configure -- --check\n' +
        '  bun run deploy:check                     # then re-run this',
    };
  }

  const notices = [...config.notices];

  for (const target of targets) {
    const workerName = DEPLOYMENT_CONFIG.workerNames[target];
    if (workerName === null) {
      return {
        ok: false,
        reason: `No Worker name is configured for "${target}" in the ${environment} environment.`,
        remedy: 'Set workerNames in packages/shared/schemas/src/registry/app_registry.ts.',
      };
    }
  }

  const steps: Step[] = targets.map((target) => ({
    target,
    description: `Deploy the ${target} Worker to Cloudflare (${environment})`,
    command: 'wrangler',
    args: [
      'deploy',
      '--env',
      environment,
      ...(target === 'client' ? ['--assets-only'] : []),
      ...(target === 'api' ? ['--config', `${API_DIR}/wrangler.jsonc`] : []),
    ],
    cwd: target === 'client' ? CLIENT_DIR : API_DIR,
    remote: true,
  }));

  if (environment === 'production') {
    notices.push(
      'A production deploy changes live traffic. Re-check the plan with --dry-run first.',
    );
  }
  notices.push(
    'This deploys application code only. It does not publish source, create ' +
      'resources, migrate databases, or release native binaries.',
  );

  return { ok: true, steps, notices };
};

/**
 * Render a built plan for a person. The same text the process boundary compares against.
 *
 * Exported so the dry-run path can be asserted at the boundary it actually has —
 * the text an operator reads — rather than on the flag that selects it. A dry run
 * that renders nothing, or renders something other than what it would spawn, is a
 * dry run that can lie, and that is the whole claim being tested.
 */
export const renderPlan = (plan: Extract<Plan, { ok: true }>, environment: string): string => {
  const lines = [`Deploy plan (${environment})`, ''];
  for (const [index, step] of plan.steps.entries()) {
    lines.push(`  ${index + 1}. ${step.description}`);
    // Rendered as the process will actually be spawned, which is the only form
    // that can be compared against a real process boundary.
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

/**
 * Execute an already-built plan.
 *
 * Takes the plan rather than argv so `--dry-run` and a real run provably operate
 * on the same steps. `runner` is the same seam `runWrangler` uses, so a test can
 * observe the exact argv without spawning anything.
 */
export const executePlan = (
  plan: Extract<Plan, { ok: true }>,
  environment: DeploymentEnvironment,
  argv: readonly string[],
): { code: number } => {
  for (const step of plan.steps) {
    const consent = requireRemoteConsent(step.target, argv);
    if (!consent.allowed) {
      process.stderr.write(`${consent.reason}\n`);
      return { code: 1 };
    }
  }

  for (const step of plan.steps) {
    process.stdout.write(`\n>>> ${step.description}\n`);
    process.stdout.write(`    ${step.command} ${step.args.join(' ')}\n`);
    const code = runWrangler(step.args, { cwd: step.cwd });
    if (code !== 0) {
      process.stderr.write(`\n${step.target} deploy failed with exit code ${code}.\n`);
      return { code };
    }
  }

  process.stdout.write(`\nDeployed. Verify with:\n  bun run logs api --mode ${environment}\n`);
  return { code: 0 };
};

/**
 * CLI entry point.
 *
 * Parses argv, builds the plan once, and either prints it or executes it. Dry run
 * and execution consume the same `Plan` object — the property the deploy tests
 * assert at the process boundary.
 */
export const main = (argv: readonly string[]): number => {
  const parsed = parseDeployArgs(argv);

  if (!parsed.ok) {
    process.stderr.write(`${parsed.errors.join('\n')}\n\n${usageText()}\n`);
    return EXIT.usage;
  }

  if (parsed.help) {
    process.stdout.write(`${usageText()}\n`);
    return EXIT.ok;
  }

  const plan = planDeploy(parsed.targets, parsed.environment);

  if (!plan.ok) {
    process.stderr.write(`${plan.reason}\n${plan.remedy}\n`);
    return EXIT.failed;
  }

  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          environment: parsed.environment,
          targets: parsed.targets,
          dryRun: parsed.dryRun,
          steps: plan.steps,
          notices: plan.notices,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.ok;
  }

  if (parsed.dryRun) {
    process.stdout.write(`${renderPlan(plan, parsed.environment)}\n`);
    process.stdout.write('\nDry run: nothing was changed.\n');
    return EXIT.ok;
  }

  if (!wranglerAvailable()) {
    process.stderr.write('wrangler is not available. Run `bun install` first.\n');
    // `unavailable`, not `failed`: the tool is missing, which is a different thing
    // from a deploy step that ran and failed.
    return EXIT.unavailable;
  }

  return executePlan(plan, parsed.environment, argv).code;
};

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}

export { wranglerAvailable } from '../cloudflare/wrangler.ts';
export type { DeploymentEnvironment, ProcessRunner };
export { setProcessRunner };
