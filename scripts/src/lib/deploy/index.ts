// scripts/src/lib/deploy/index.ts
//
// Deploy, with a dry run that is the default path.
//
//   bun run deploy:check          # validate. Mutates nothing. The recommended
//                                 # first command against a new account.
//   bun run deploy -- --dry-run   # print every command that would run
//   bun run deploy -- --env staging --yes
//
// The separation the source project lacked: **build, source publication,
// resource provisioning and application deployment are four different things**,
// and this command only ever does the last one. Publishing a repository does not
// deploy it. Creating a database does not deploy code. A deploy does not publish
// anything.

import { APP_LOG_CONFIG, DEPLOYMENT_CONFIG, type DeploymentEnvironment } from '@starter/schemas';
import {
  API_DIR,
  CLIENT_DIR,
  captureWrangler,
  hasCloudflareCredential,
  REPO_ROOT,
  requireRemoteConsent,
  runWrangler,
  wranglerAvailable,
} from '../cloudflare/wrangler.ts';
import { type ConfigCheck, inspectConfig } from './configure.ts';

export type DeployTarget = 'api' | 'client';

export interface Step {
  target: DeployTarget;
  description: string;
  command: string;
  args: string[];
  /** Requires a remote mutation, so it needs explicit consent. */
  remote: boolean;
}

export type Plan =
  | { ok: true; steps: Step[]; notices: string[] }
  | { ok: false; reason: string; remedy: string };

const VALID_TARGETS: readonly DeployTarget[] = ['api', 'client'];

/**
 * Build the deploy plan without executing anything.
 *
 * Exported so `--dry-run` and the test suite assert on the *same* plan. A
 * dry run that re-derives the commands is a dry run that can lie.
 *
 * `config` is injectable for one reason: the template provisions nothing, so
 * `inspectConfig()` refuses in every test run. Without the seam, every assertion
 * about the *contents* of a plan — the commands, the consent gate, the notices —
 * would sit behind `if (plan.ok)` and never execute. Those tests would pass
 * forever while checking nothing, which is the failure mode this parameter
 * exists to remove.
 */
export const planDeploy = (
  targets: readonly DeployTarget[],
  environment: DeploymentEnvironment,
  config: ConfigCheck = inspectConfig(),
): Plan => {
  if (!config.ok) {
    return {
      ok: false,
      // The specific problems, not just a headline. Someone fixing this has
      // five things to check; making them run `deploy:configure --check`
      // separately to find out which is the wrong division of labour.
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

  // `parseTargets` already filters argv, so this cannot trigger from the CLI —
  // but `planDeploy` is exported, and a step built from an unvalidated string
  // would be a wrangler command for a target this project does not have.
  for (const target of targets) {
    if (!VALID_TARGETS.includes(target)) {
      return {
        ok: false,
        reason: `"${target}" is not a deploy target.`,
        remedy: `Valid targets: ${VALID_TARGETS.join(', ')}.`,
      };
    }
  }

  if (environment !== 'local') {
    for (const target of targets) {
      const workerName = DEPLOYMENT_CONFIG.workerNames[target];
      if (workerName === null) {
        return {
          ok: false,
          // Names the environment that was actually requested. The previous
          // ternary re-read the same value it had just tested, so it always
          // printed "any environment" — telling someone who ran
          // `--env staging` that the problem was not specific to staging.
          reason: `No Worker name is configured for "${target}" in the ${environment} environment.`,
          remedy: 'Set workerNames in packages/shared/schemas/src/registry/app_registry.ts.',
        };
      }
    }
  }

  const steps: Step[] = targets.map((target) => ({
    target,
    description: `Deploy the ${target} Worker to Cloudflare (${environment})`,
    command: 'bunx',
    args: [
      'wrangler',
      'deploy',
      ...(target === 'client' ? ['--assets-only'] : []),
      ...(environment === 'local' ? [] : ['--env', environment]),
      ...(target === 'api' ? ['--config', `${API_DIR}/wrangler.jsonc`] : []),
    ],
    remote: environment !== 'local',
  }));

  if (environment === 'production') {
    notices.push(
      'A production deploy changes live traffic. Confirm the change and re-check ' +
        'the plan with --dry-run first.',
    );
  }
  notices.push(
    'This deploys application code only. It does not publish source, create ' +
      'resources, or release native binaries.',
  );

  return { ok: true, steps, notices };
};

const renderPlan = (
  plan: Extract<Plan, { ok: true }>,
  environment: DeploymentEnvironment,
): void => {
  process.stdout.write(`Deploy plan (${environment})\n\n`);
  for (const [index, step] of plan.steps.entries()) {
    process.stdout.write(`  ${index + 1}. ${step.description}\n`);
    process.stdout.write(`     ${step.command} ${step.args.join(' ')}\n`);
  }
  if (plan.notices.length > 0) {
    process.stdout.write('\nNotes:\n');
    for (const notice of plan.notices) {
      process.stdout.write(`  - ${notice}\n`);
    }
  }
};

export const parseEnvironment = (args: readonly string[]): DeploymentEnvironment | null => {
  const index = args.indexOf('--env');

  // No flag at all: default to staging, which is the safe direction for a
  // command that changes live systems.
  if (index === -1) {
    return 'staging';
  }

  const value = args[index + 1];

  // `--env` with no value, or `--env --dry-run`, is a mistake and is reported as
  // one. Returning the default here would have silently deployed to staging
  // because the user typed a flag with no argument.
  if (value === undefined || value.startsWith('-')) {
    return null;
  }

  if (value === 'staging' || value === 'production' || value === 'local') {
    return value;
  }
  return null;
};

export const parseTargets = (args: readonly string[]): DeployTarget[] | null => {
  const explicit = args.filter(
    (arg) => !arg.startsWith('-') && VALID_TARGETS.includes(arg as DeployTarget),
  );
  if (explicit.length === 0) {
    return [...VALID_TARGETS];
  }
  return [...new Set(explicit as DeployTarget[])];
};

export const main = (args: readonly string[]): number => {
  const environment = parseEnvironment(args);
  if (environment === null) {
    process.stderr.write('--env must be local, staging or production.\n');
    return 2;
  }

  const targets = parseTargets(args);
  if (targets === null || targets.length === 0) {
    process.stderr.write(`--app must be one of ${VALID_TARGETS.join(', ')}.\n`);
    return 2;
  }

  const dryRun = args.includes('--dry-run');
  const plan = planDeploy(targets, environment);

  if (!plan.ok) {
    process.stderr.write(`${plan.reason}\n${plan.remedy}\n`);
    return 1;
  }

  if (dryRun) {
    renderPlan(plan, environment);
    process.stdout.write('\nDry run: nothing was changed.\n');
    return 0;
  }

  if (!wranglerAvailable()) {
    process.stderr.write('wrangler is not available. Run `bun install` first.\n');
    return 1;
  }

  for (const step of plan.steps) {
    if (step.remote) {
      const consent = requireRemoteConsent(step.target, args);
      if (!consent.allowed) {
        process.stderr.write(`${consent.reason}\n`);
        return 1;
      }
    }
  }

  for (const step of plan.steps) {
    process.stdout.write(`\n>>> ${step.description}\n`);
    const code = runWrangler(step.args, {
      cwd: step.target === 'client' ? CLIENT_DIR : REPO_ROOT,
    });
    if (code !== 0) {
      process.stderr.write(`\n${step.target} deploy failed with exit code ${code}.\n`);
      return code;
    }
  }

  process.stdout.write(`\nDeployed. Verify with:\n  bun run logs api --mode ${environment}\n`);
  return 0;
};

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}

export { APP_LOG_CONFIG, captureWrangler, DEPLOYMENT_CONFIG, hasCloudflareCredential };
