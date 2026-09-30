// scripts/src/lib/deploy/deploy.test.ts
//
// Deploy planning, with nothing deployed.
//
// `planDeploy` is the only thing that decides what a deploy *would* do, and both
// `--dry-run` and these tests read the same plan. A dry run that re-derives its
// commands is a dry run that can lie — it would print something reassuring while
// the real run does something else.
//
// Nothing here touches the network or a credential. The plan is a pure function of
// the registry and the environment, which is the property that makes it testable
// at all.
//
// The `configCheck` fixture is the point of the file. The template provisions
// nothing, so the real `inspectConfig()` refuses in every run; asserting plan
// *contents* against that refusal would leave every command-level test behind an
// `if (plan.ok)` that never executes — passing permanently while checking
// nothing. `planDeploy` takes its config check as a parameter so a plan can be
// built and inspected here, while the refusal path is tested on its own terms.

import { afterEach, describe, expect, test } from 'bun:test';
import { DEPLOYMENT_CONFIG } from '@starter/schemas';
import type { ConfigCheck } from '../src/deploy/configure.ts';
import { type DeployTarget, parseDeployArgs, planDeploy, type Step } from '../src/deploy/deploy.ts';

/** A configuration that passes every check. */
const READY: ConfigCheck = { ok: true, problems: [], notices: [] };

const savedWorkerNames = { ...DEPLOYMENT_CONFIG.workerNames };

const setWorkerNames = (names: Partial<Record<DeployTarget, string | null>>): void => {
  for (const [target, value] of Object.entries(names)) {
    DEPLOYMENT_CONFIG.workerNames[target as DeployTarget] = value;
  }
};

afterEach(() => {
  setWorkerNames(savedWorkerNames);
});

/**
 * Name both Workers for the duration of `body`.
 *
 * A remote deploy is refused unless every requested target has a Worker name, so a
 * test about step *contents* has to provision one. Names are obviously fake and
 * are never used for anything but satisfying the gate.
 */
const withWorkerNames = <T>(body: () => T): T => {
  setWorkerNames({ api: 'test-api-worker', client: 'test-client-worker' });
  try {
    return body();
  } finally {
    setWorkerNames(savedWorkerNames);
  }
};

/** A plan that is guaranteed to be built, or the test fails loudly. */
const planFor = (
  targets: readonly DeployTarget[],
  environment: 'staging' | 'production',
  config: ConfigCheck = READY,
): Step[] =>
  withWorkerNames(() => {
    const plan = planDeploy(targets, environment, config);
    if (!plan.ok) {
      throw new Error(`expected a plan, got refusal: ${plan.reason}`);
    }
    return plan.steps;
  });

const planForFull = (
  targets: readonly DeployTarget[],
  environment: 'staging' | 'production',
  config: ConfigCheck = READY,
) =>
  withWorkerNames(() => {
    const plan = planDeploy(targets, environment, config);
    if (!plan.ok) {
      throw new Error(`expected a plan, got refusal: ${plan.reason}`);
    }
    return plan;
  });

/** The argv as it will be handed to the wrangler wrapper. */
const argvOf = (steps: readonly Step[]): string[][] => steps.map((step) => [...step.args]);

const argvTextOf = (steps: readonly Step[]): string[] =>
  steps.map((step) => [step.command, ...step.args].join(' '));

describe('planDeploy: refusal', () => {
  test('refuses when Cloudflare is not configured', () => {
    // The template's actual first result. It must be a refusal with a remedy,
    // never a plan against a guessed target.
    const plan = planDeploy(['api'], 'production');

    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).toBeTruthy();
    expect(plan.remedy).toContain('deploy:configure');
  });

  test('carries the problems from the config check into the refusal', () => {
    const plan = planDeploy(['api'], 'production', {
      ok: false,
      problems: ['No Cloudflare credential.', 'No D1 database id configured for the API.'],
      notices: [],
    });

    if (plan.ok) {
      throw new Error('expected a refusal');
    }
    // The user should not have to re-run `deploy:configure --check` to find out
    // which of five things is wrong.
    expect(plan.reason).toContain('D1 database id');
  });

  test('refuses a remote deploy with no Worker name for the target', () => {
    setWorkerNames({ api: null, client: 'client-worker' });

    const plan = planDeploy(['api'], 'staging', READY);

    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    // Naming the target is what makes the message actionable.
    expect(plan.reason).toContain('"api"');
    expect(plan.remedy).toContain('workerNames');
  });

  test('refuses when a different target has no Worker name', () => {
    // Deploying only `api` must not be blocked by `client` being unconfigured —
    // and equally, deploying `client` must not pass because `api` is fine.
    setWorkerNames({ api: 'api-worker', client: null });

    expect(planDeploy(['api'], 'production', READY).ok).toBe(true);
    expect(planDeploy(['client'], 'production', READY).ok).toBe(false);
  });

  // `local` was previously "not remote", which meant consent was skipped and a
  // `wrangler deploy` command was built anyway.
  test('refuses to plan a local deployment at all', () => {
    setWorkerNames({ api: null, client: null });

    const plan = planDeploy(['api'], 'local' as 'staging', READY);

    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).toContain('not a deployable environment');
    expect(plan.remedy).toContain('dev:api');
  });
});

describe('parseDeployArgs', () => {
  test('accepts the two deployable environments', () => {
    for (const environment of ['staging', 'production'] as const) {
      const parsed = parseDeployArgs(['--env', environment]);
      expect(parsed.ok && parsed.environment).toBe(environment);
    }
  });

  test('defaults to staging when no flag is given', () => {
    // Staging rather than production: the safer default for a command whose whole
    // purpose is changing live systems.
    const parsed = parseDeployArgs([]);
    expect(parsed.ok && parsed.environment).toBe('staging');
  });

  test('rejects an unrecognised environment rather than falling back', () => {
    // Falling back would deploy to staging when the user asked for something else,
    // and report success.
    for (const argv of [
      ['--env', 'prod'],
      ['--env', 'PRODUCTION'],
      ['--env', 'qa'],
    ]) {
      const parsed = parseDeployArgs(argv);
      expect(parsed.ok).toBe(false);
    }
  });

  // The distinction the audit called out: a *local invocation* is running this CLI
  // on a laptop; `--env local` is a request for a local deployment target, which
  // this command does not have. Local workerd is `bun run dev:api`.
  test('rejects --env local and points at the real local path', () => {
    const parsed = parseDeployArgs(['--env', 'local']);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors.join('\n')).toContain('dev:api');
  });

  test('rejects --env with no value', () => {
    const parsed = parseDeployArgs(['--env']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors.join('\n')).toContain('needs a value');
  });

  test('rejects two different --env values', () => {
    const parsed = parseDeployArgs(['--env', 'staging', '--env', 'production']);
    expect(parsed.ok).toBe(false);
  });

  test('accepts a repeated identical --env', () => {
    const parsed = parseDeployArgs(['--env', 'staging', '--env', 'staging']);
    expect(parsed.ok && parsed.environment).toBe('staging');
  });
});

describe('parseDeployArgs: targets', () => {
  test('defaults to every target when no target word is given', () => {
    const parsed = parseDeployArgs([]);
    expect(parsed.ok && parsed.targets).toEqual(['api', 'client']);
  });

  test('selects one named target', () => {
    const parsed = parseDeployArgs(['api']);
    expect(parsed.ok && parsed.targets).toEqual(['api']);
  });

  test('selects several targets in order', () => {
    const parsed = parseDeployArgs(['client', 'api']);
    expect(parsed.ok && parsed.targets).toEqual(['client', 'api']);
  });

  test('deduplicates a repeated target', () => {
    // Otherwise a deploy runs twice, which for a deployment means a second upload
    // to live traffic.
    const parsed = parseDeployArgs(['api', 'api']);
    expect(parsed.ok && parsed.targets).toEqual(['api']);
  });

  // THE DEFECT: `parseTargets` filtered argv down to tokens that happened to be
  // valid and defaulted to "both" when nothing survived, so `-- ap` deployed the
  // API *and* the client to production.
  test('an unknown target word is an error, not a deploy of everything', () => {
    const parsed = parseDeployArgs(['clientt']);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors.join('\n')).toContain('Unknown target "clientt"');
  });

  test('an unknown word among valid ones is still an error', () => {
    const parsed = parseDeployArgs(['api', 'databse']);
    expect(parsed.ok).toBe(false);
  });

  test('flags are not mistaken for targets', () => {
    const parsed = parseDeployArgs(['--dry-run', 'api', '--yes']);
    expect(parsed.ok && parsed.targets).toEqual(['api']);
  });

  test('a flag argument is not mistaken for a target', () => {
    const parsed = parseDeployArgs(['--env', 'production']);
    expect(parsed.ok && parsed.targets).toEqual(['api', 'client']);
  });

  test('an unknown flag is an error', () => {
    const parsed = parseDeployArgs(['--forse', 'api']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors.join('\n')).toContain('Unknown flag');
  });

  test('--dry-run and --json are recognised', () => {
    const parsed = parseDeployArgs(['--dry-run', '--json']);
    expect(parsed.ok && parsed.dryRun).toBe(true);
    expect(parsed.ok && parsed.json).toBe(true);
  });
});

describe('planDeploy: steps', () => {
  test('produces one step per target, in order', () => {
    expect(planFor(['api', 'client'], 'production').map((step) => step.target)).toEqual([
      'api',
      'client',
    ]);
  });

  // THE DEFECT: `planDeploy` put `wrangler` in `args` and `runWrangler` prepended
  // it again, so the process that actually ran was `wrangler wrangler deploy`.
  test('args never contain the wrangler token', () => {
    for (const argv of argvOf(planFor(['api', 'client'], 'production'))) {
      expect(argv.filter((token) => token === 'wrangler')).toHaveLength(0);
    }
  });

  test('the first argument is the subcommand', () => {
    for (const argv of argvOf(planFor(['api', 'client'], 'production'))) {
      expect(argv[0]).toBe('deploy');
    }
  });

  test('the api step names its own config file', () => {
    // The two apps are configured separately; the api step without a config path
    // would deploy whatever wrangler finds in the working directory.
    const [apiStep] = planFor(['api'], 'production');

    expect(apiStep?.args).toContain('--config');
    expect(apiStep?.args.some((arg) => arg.endsWith('wrangler.jsonc'))).toBe(true);
  });

  test('the client step deploys assets only', () => {
    // The client is a static bundle. Deploying a Worker for it would provision
    // something the project does not use.
    const [clientStep] = planFor(['client'], 'production');
    expect(clientStep?.args).toContain('--assets-only');
  });

  test('the client step passes no --config', () => {
    const [clientStep] = planFor(['client'], 'production');
    expect(clientStep?.args).not.toContain('--config');
  });

  test('a remote step always carries its environment', () => {
    for (const environment of ['staging', 'production'] as const) {
      const [step] = planFor(['api'], environment);
      expect(step?.args).toContain('--env');
      expect(step?.args).toContain(environment);
    }
  });

  test('each step carries its own working directory', () => {
    // The api step must run where its config lives, the client step where its
    // assets do. Previously both used one root for everything except the client.
    const [apiStep, clientStep] = planFor(['api', 'client'], 'production');

    expect(apiStep?.cwd).toContain('apps/backend/api');
    expect(clientStep?.cwd).toContain('apps/frontend/client');
  });

  test('carries a human description as well as a command', () => {
    for (const step of planFor(['api', 'client'], 'production')) {
      expect(step.description).toContain(step.target);
      expect(step.description).toContain('production');
    }
  });
});

describe('planDeploy: the consent gate', () => {
  test('every step is remote, because every deployable environment is remote', () => {
    // A production step marked non-remote would deploy to live traffic with no
    // confirmation. There is no longer a non-remote deploy path.
    for (const environment of ['staging', 'production'] as const) {
      for (const step of planFor(['api', 'client'], environment)) {
        expect(step.remote).toBe(true);
      }
    }
  });
});

describe('planDeploy: what it will never do', () => {
  test('no source-publication command', () => {
    // Publishing is a different action with different consequences. If it ever
    // appears in a deploy plan, `bun run deploy` would push a repository.
    for (const command of argvTextOf(planFor(['api', 'client'], 'production'))) {
      expect(command).not.toContain('git push');
      expect(command).not.toContain('gh release');
      expect(command).not.toContain('npm publish');
    }
  });

  test('no provisioning command', () => {
    // Creating a database or bucket is not deploying, and is not undone by
    // removing the deploy.
    for (const command of argvTextOf(planFor(['api', 'client'], 'production'))) {
      expect(command).not.toContain('d1 create');
      expect(command).not.toContain('r2 bucket create');
      expect(command).not.toContain('d1 execute');
    }
  });

  test('no migration command', () => {
    // Migrations change a database's shape. Running them as part of a deploy would
    // make a code rollback insufficient to undo a failed release.
    for (const command of argvTextOf(planFor(['api'], 'production'))) {
      expect(command).not.toContain('migrate');
      expect(command).not.toContain('db:');
    }
  });

  test('no credential appears in a command', () => {
    for (const command of argvTextOf(planFor(['api'], 'production'))) {
      expect(command).not.toMatch(/CLOUDFLARE_API_TOKEN=\S/);
      expect(command).not.toMatch(/--api-token\s+\S/);
    }
  });

  test('no command deletes or removes anything', () => {
    for (const command of argvTextOf(planFor(['api', 'client'], 'production'))) {
      expect(command).not.toContain('delete');
      expect(command).not.toContain('rm ');
      expect(command).not.toContain('--force');
    }
  });

  test('an unknown target is refused, not deployed', () => {
    // `parseDeployArgs` rejects one, but `planDeploy` is exported and callers
    // (including these tests) pass arrays directly. A plan built from an
    // unvalidated string would be a deploy command for a nonexistent app.
    setWorkerNames({ api: 'test-api-worker', client: 'test-client-worker' });

    expect(planDeploy(['database' as DeployTarget], 'production', READY).ok).toBe(false);
  });
});

describe('planDeploy: notices', () => {
  test('always states that a deploy is not a source publication', () => {
    // The distinction this tool exists to make. A user who believes otherwise will
    // act on the belief — most visibly by expecting `git` to have run.
    for (const environment of ['staging', 'production'] as const) {
      expect(planForFull(['api'], environment).notices.join('\n')).toContain('does not publish');
    }
  });

  test('always states that it creates no resources', () => {
    for (const environment of ['staging', 'production'] as const) {
      expect(planForFull(['api'], environment).notices.join('\n')).toContain('create');
    }
  });

  test('warns that a production deploy changes live traffic', () => {
    expect(planForFull(['api'], 'production').notices.join('\n')).toContain('live traffic');
  });

  test('does not raise a live-traffic warning for staging', () => {
    // Staging traffic is also real to whoever looks at it, but the wording is
    // reserved for the one case where the warning must not be missed.
    expect(planForFull(['api'], 'staging').notices.join('\n')).not.toContain('live traffic');
  });

  test('carries forward the notices from the config check', () => {
    const plan = planForFull(['api'], 'production', {
      ok: true,
      problems: [],
      notices: ['No custom domain configured; *.workers.dev only.'],
    });

    expect(plan.notices).toContain('No custom domain configured; *.workers.dev only.');
  });
});
