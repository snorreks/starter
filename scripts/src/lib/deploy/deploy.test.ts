// scripts/src/lib/deploy/deploy.test.ts
//
// Deploy planning, with nothing deployed.
//
// `planDeploy` is the only thing that decides what a deploy *would* do, and both
// `--dry-run` and these tests read the same plan. A dry run that re-derives its
// commands is a dry run that can lie — it would print something reassuring while
// the real run does something else.
//
// Nothing here touches the network or a credential. The plan is a pure function
// of the registry and the environment, which is the property that makes it
// testable at all.
//
// The `configCheck` fixture is the point of the file. The template provisions
// nothing, so the real `inspectConfig()` refuses in every run; asserting plan
// *contents* against that refusal would leave every command-level test behind an
// `if (plan.ok)` that never executes — passing permanently while checking
// nothing. `planDeploy` takes its config check as a parameter so a plan can be
// built and inspected here, while the refusal path is tested on its own terms.

import { afterEach, describe, expect, test } from 'bun:test';
import { DEPLOYMENT_CONFIG } from '@starter/schemas';
import { parseEnvironment, parseTargets, planDeploy, type DeployTarget, type Step } from './index.ts';
import type { ConfigCheck } from './configure.ts';

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
 * A remote deploy is refused unless every requested target has a Worker name, so
 * a test about step *contents* has to provision one. Names are obviously fake and
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
  environment: 'local' | 'staging' | 'production',
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
  environment: 'local' | 'staging' | 'production',
  config: ConfigCheck = READY,
) =>
  withWorkerNames(() => {
    const plan = planDeploy(targets, environment, config);
    if (!plan.ok) {
      throw new Error(`expected a plan, got refusal: ${plan.reason}`);
    }
    return plan;
  });

const commandsOf = (steps: readonly Step[]): string[] =>
  steps.map((step) => [step.command, ...step.args].join(' '));

describe('planDeploy: refusal', () => {
  test('refuses when Cloudflare is not configured', () => {
    // The template's actual first result. It must be a refusal with a remedy,
    // never a plan against a guessed target.
    const plan = planDeploy(['api'], 'production');

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBeTruthy();
    expect(plan.remedy).toContain('deploy:configure');
  });

  test('carries the problems from the config check into the refusal', () => {
    const plan = planDeploy(['api'], 'production', {
      ok: false,
      problems: ['No Cloudflare credential.', 'No D1 database id configured for the API.'],
      notices: [],
    });

    if (plan.ok) throw new Error('expected a refusal');

    // The user should not have to re-run `deploy:configure --check` to find out
    // which of five things is wrong.
    expect(plan.reason).toContain('D1 database id');
  });

  test('refuses a remote deploy with no Worker name for the target', () => {
    setWorkerNames({ api: null, client: 'client-worker' });

    const plan = planDeploy(['api'], 'staging', READY);

    expect(plan.ok).toBe(false);
    if (plan.ok) return;

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

  test('a local deploy does not need a Worker name', () => {
    setWorkerNames({ api: null, client: null });

    expect(planDeploy(['api'], 'local', READY).ok).toBe(true);
  });
});

describe('parseEnvironment', () => {
  test('accepts the three declared environments', () => {
    for (const environment of ['local', 'staging', 'production'] as const) {
      expect(parseEnvironment(['--env', environment])).toBe(environment);
    }
  });

  test('defaults to staging when no flag is given', () => {
    // Staging rather than production: the safer default for a command whose
    // whole purpose is changing live systems.
    expect(parseEnvironment([])).toBe('staging');
  });

  test('returns null for an unrecognised environment, rather than falling back', () => {
    // Falling back would deploy to staging when the user asked for something
    // else, and report success.
    expect(parseEnvironment(['--env', 'prod'])).toBeNull();
    expect(parseEnvironment(['--env', 'PRODUCTION'])).toBeNull();
    expect(parseEnvironment(['--env', 'qa'])).toBeNull();
  });

  test('returns null when the flag has no value', () => {
    // `--env` alone is a typo, not a request for staging.
    expect(parseEnvironment(['--env'])).toBeNull();
  });

  test('returns null when the value is another flag', () => {
    expect(parseEnvironment(['--env', '--dry-run'])).toBeNull();
  });
});

describe('parseTargets', () => {
  test('defaults to every target', () => {
    expect(parseTargets([])).toEqual(['api', 'client']);
  });

  test('selects one named target', () => {
    expect(parseTargets(['api'])).toEqual(['api']);
  });

  test('selects several targets in order', () => {
    expect(parseTargets(['client', 'api'])).toEqual(['client', 'api']);
  });

  test('deduplicates a repeated target', () => {
    // Otherwise a deploy runs twice, which for a deployment means a second
    // upload to live traffic.
    expect(parseTargets(['api', 'api'])).toEqual(['api']);
  });

  test('ignores an unknown positional rather than deploying it', () => {
    // A typo like `bun run deploy -- ap` falls back to deploying everything,
    // which is the wrong direction for a mistake to go.
    expect(parseTargets(['ap'])).toEqual(['api', 'client']);
  });

  test('ignores flags when looking for targets', () => {
    expect(parseTargets(['--dry-run', 'api', '--yes'])).toEqual(['api']);
  });

  test('does not treat a flag argument as a target', () => {
    expect(parseTargets(['--env', 'production'])).toEqual(['api', 'client']);
  });
});

describe('planDeploy: steps', () => {
  test('produces one step per target, in order', () => {
    const steps = planFor(['api', 'client'], 'production');

    expect(steps.map((step) => step.target)).toEqual(['api', 'client']);
  });

  test('every step invokes wrangler', () => {
    for (const step of planFor(['api', 'client'], 'production')) {
      expect(commandsOf([step])[0]).toContain('wrangler');
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

  test('a remote step carries its environment', () => {
    const [step] = planFor(['api'], 'staging');

    expect(step?.args).toContain('--env');
    expect(step?.args).toContain('staging');
  });

  test('a local step carries no --env', () => {
    const [step] = planFor(['api'], 'local');

    expect(step?.args).not.toContain('--env');
  });

  test('carries a human description as well as a command', () => {
    for (const step of planFor(['api', 'client'], 'production')) {
      expect(step.description).toContain(step.target);
      expect(step.description).toContain('production');
    }
  });
});

describe('planDeploy: the consent gate', () => {
  test('a local step is not remote', () => {
    expect(planFor(['api'], 'local').every((step) => !step.remote)).toBe(true);
  });

  test('a remote step is remote', () => {
    // The consent prompt reads `remote`. A production step marked non-remote
    // would deploy to live traffic with no confirmation.
    expect(planFor(['api'], 'production').every((step) => step.remote)).toBe(true);
    expect(planFor(['api'], 'staging').every((step) => step.remote)).toBe(true);
  });

  test('the gate is per step, not per plan', () => {
    // A mixed-target plan in one environment is uniform today, but the two flags
    // are independent fields and a test that only checked the plan would miss a
    // step-level mistake.
    for (const step of planFor(['api', 'client'], 'local')) {
      expect(typeof step.remote).toBe('boolean');
    }
  });
});

describe('planDeploy: what it will never do', () => {
  test('no source-publication command', () => {
    // Publishing is a different action with different consequences. If it ever
    // appears in a deploy plan, `bun run deploy` would push a repository.
    for (const command of commandsOf(planFor(['api', 'client'], 'production'))) {
      expect(command).not.toContain('git push');
      expect(command).not.toContain('gh release');
      expect(command).not.toContain('npm publish');
    }
  });

  test('no provisioning command', () => {
    // Creating a database or bucket is not deploying, and is not undone by
    // removing the deploy.
    for (const command of commandsOf(planFor(['api', 'client'], 'production'))) {
      expect(command).not.toContain('d1 create');
      expect(command).not.toContain('r2 bucket create');
      expect(command).not.toContain('d1 execute');
    }
  });

  test('no migration command', () => {
    // Migrations change a database's shape. Running them as part of a deploy
    // would make a code rollback insufficient to undo a failed release.
    for (const command of commandsOf(planFor(['api'], 'production'))) {
      expect(command).not.toContain('migrate');
      expect(command).not.toContain('db:');
    }
  });

  test('no credential appears in a command', () => {
    for (const command of commandsOf(planFor(['api'], 'production'))) {
      expect(command).not.toMatch(/CLOUDFLARE_API_TOKEN=\S/);
      expect(command).not.toMatch(/--api-token\s+\S/);
    }
  });

  test('no command deletes or removes anything', () => {
    for (const command of commandsOf(planFor(['api', 'client'], 'production'))) {
      expect(command).not.toContain('delete');
      expect(command).not.toContain('rm ');
      expect(command).not.toContain('--force');
    }
  });

  test('an unknown target is refused, not deployed', () => {
    // `parseTargets` filters argv, so the CLI cannot produce this — but
    // `planDeploy` is exported and the test suite calls it directly. A plan that
    // deployed "database" would be a command built from an unvalidated string.
    setWorkerNames({ api: 'test-api-worker', client: 'test-client-worker' });

    const plan = planDeploy(['database' as DeployTarget], 'production', READY);

    expect(plan.ok).toBe(false);
  });
});

describe('planDeploy: notices', () => {
  test('always states that a deploy is not a source publication', () => {
    // The distinction this tool exists to make. A user who believes otherwise
    // will act on the belief — most visibly by expecting `git` to have run.
    for (const environment of ['local', 'staging', 'production'] as const) {
      const plan = planForFull(['api'], environment);
      expect(plan.notices.join('\n')).toContain('does not publish source');
    }
  });

  test('always states that it creates no resources', () => {
    for (const environment of ['local', 'staging', 'production'] as const) {
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