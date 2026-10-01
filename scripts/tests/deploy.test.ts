// scripts/src/deploy/deploy.test.ts
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

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// For one assertion only, and deliberately: the check below is that the committed
// `wrangler.jsonc` *is committed*, which is a fact about the repository rather than
// about whoever last ran a build.
import { CLIENT_DIR } from '../src/cloudflare/wrangler.ts';
import type { ConfigCheck } from '../src/deploy/configure.ts';
import { type DeployTarget, parseDeployArgs, planDeploy, type Step } from '../src/deploy/deploy.ts';
import { DEPLOYMENT_CONFIG } from '../src/registry/app_registry.ts';
import {
  effectiveDeploymentValues,
  LOCAL_DEPLOYMENT_FILE,
  setDeploymentValues,
} from '../src/registry/deployment_values.ts';

/** A configuration that passes every check. */
const READY: ConfigCheck = { ok: true, problems: [], notices: [] };

const savedWorkerNames = { ...DEPLOYMENT_CONFIG.workerNames };

/**
 * Set the Worker names for the duration of a test.
 *
 * This installs values through the resolver seam rather than mutating
 * `DEPLOYMENT_CONFIG`. The old version assigned to the committed module, which
 * production no longer reads — provisioning writes a gitignored overlay and the
 * environment, and the module is only the floor. That gap is why every test here
 * passed while `deploy:check` reported "no Worker name" for a project that had
 * provisioned one: the tests set the one value the code did not read.
 */
const setWorkerNames = (names: Partial<Record<DeployTarget, string | null>>): void => {
  const current = effectiveDeploymentValues();
  setDeploymentValues({
    ...current,
    workerNames: { ...current.workerNames, ...names },
  });
};

afterEach(() => {
  // Clear the injection rather than restoring a snapshot: leaving values
  // installed would leak into every later test file in this process, and a test
  // that passes because of another file's leftovers is not a test.
  setWorkerNames(savedWorkerNames);
  setDeploymentValues(null);
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

/**
 * Temp client trees, one with a build output and one without.
 *
 * `planDeploy` refuses a client deploy whose `build/index.html` is absent, so every
 * test that plans a client target has to say which world it is in. Reading the real
 * `CLIENT_DIR` made the suite depend on build state — see the refusal test below for
 * what that cost in CI.
 */
const makeClientTree = (withBuild: boolean): string => {
  const dir = mkdtempSync(join(tmpdir(), 'starter-client-'));
  created.push(dir);
  if (withBuild) {
    mkdirSync(join(dir, 'build'), { recursive: true });
    writeFileSync(join(dir, 'build', 'index.html'), '<!doctype html><title>t</title>\n', 'utf8');
  }
  return dir;
};

/** Temp client trees, removed when the file finishes. */
const created: string[] = [];

afterAll(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CLIENT_WITH_BUILD = makeClientTree(true);
const CLIENT_WITHOUT_BUILD = makeClientTree(false);

/** A plan that is guaranteed to be built, or the test fails loudly. */
const planFor = (
  targets: readonly DeployTarget[],
  environment: 'staging' | 'production',
  config: ConfigCheck = READY,
): Step[] =>
  withWorkerNames(() => {
    const plan = planDeploy(targets, environment, config, CLIENT_WITH_BUILD);
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
    const plan = planDeploy(targets, environment, config, CLIENT_WITH_BUILD);
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
    // And the remedy has to be a command that works. It used to say "Set
    // workerNames in packages/shared/schemas/src/registry/app_registry.ts", which
    // is a path that moved and a module `registry-valid` fails the build on when
    // it holds a literal id — so following the advice was impossible.
    expect(plan.remedy).toContain('deploy:configure');
    expect(plan.remedy).not.toContain('app_registry.ts');
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

  // `--dry-run=false` used to set dryRun to true: the parser split on `=` and
  // checked only the part before it, so the value was discarded and the flag's
  // presence won. A deploy command that does the opposite of what was written is
  // the worst shape this parser could have.
  test('a boolean flag with a value is rejected rather than half-read', () => {
    for (const token of ['--dry-run=false', '--yes=false', '--json=0']) {
      const parsed = parseDeployArgs([token]);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) {
        return;
      }
      expect(parsed.errors.join('\n')).toContain('without a value');
    }
  });

  test('a value flag written with = is rejected with the form to use instead', () => {
    // `--env=production` used to fall through to "Unknown flag", which reads as a
    // wrong flag name rather than a wrong syntax.
    const parsed = parseDeployArgs(['--env=production']);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors.join('\n')).toContain('--env production');
    expect(parsed.errors.join('\n')).not.toContain('Unknown flag');
  });

  test('an unknown flag with a value still reports the unknown flag', () => {
    const parsed = parseDeployArgs(['--forse=api']);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors.join('\n')).toContain('Unknown flag "--forse"');
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

  test('a client deploy with no build output is refused, not published empty', () => {
    // `--assets-only` against a missing `build/` does not fail loudly: wrangler
    // publishes an empty site and the command reports success. That is the failure
    // this guards — a green deploy of a blank page.
    //
    // A temp tree with no `build/`, rather than the repository's own. The first
    // version of this test renamed the real `build/index.html` aside and restored it
    // afterwards, which meant the suite's result depended on whether someone had run
    // `bun run build`: green locally, and three failures in CI, where the unit-test
    // step runs before the build. A test that asserts against the repository is
    // asserting against whoever cloned it last.
    const plan = withWorkerNames(() =>
      planDeploy(['client'], 'production', READY, CLIENT_WITHOUT_BUILD),
    );

    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toContain('build');
      expect(plan.remedy).toContain('bun run build');
    }
  });

  test('a client deploy with a build is planned, so the refusal above is about the artifact', () => {
    // The other half of the pair. Without this, a check that refused *everything*
    // would satisfy the test above.
    const [step] = planFor(['client'], 'production');
    expect(step?.args).toContain('--assets-only');
  });

  test('the client step names its config, which now exists', () => {
    // It used to pass no `--config` at all, because `apps/frontend/client` had no
    // wrangler config: `deploy --client` ran `--assets-only` against nothing and
    // wrangler fell back to its own defaults. The assertion was written to pin that
    // behaviour, so it was green while the deploy could not work.
    const [clientStep] = planFor(['client'], 'production');
    expect(clientStep?.args).toContain('--config');

    const configIndex = clientStep?.args.indexOf('--config') ?? -1;
    expect(clientStep?.args[configIndex + 1]).toBe('wrangler.jsonc');
    // And the file it names is really there, relative to the step's cwd.
    expect(existsSync(join(CLIENT_DIR, 'wrangler.jsonc'))).toBe(true);
  });

  test('the client step carries the Worker name the plan printed', () => {
    // Otherwise the name in the plan is a description of one thing and the deploy
    // is another: a config carrying its own name would make `deploy:check` lie
    // about what would be published.
    const [clientStep] = planFor(['client'], 'production');
    const nameIndex = clientStep?.args.indexOf('--name') ?? -1;
    expect(nameIndex).toBeGreaterThan(-1);
    expect(clientStep?.args[nameIndex + 1]).toBe('test-client-worker');
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

describe('per-environment targets', () => {
  // Gap 4. With one set of names, `--env staging` and `--env production` produced
  // *identical* plans: the flag changed a notice and nothing else. The plan looked
  // environment-specific, so the difference had to be asserted at the plan, not only
  // at the resolver.

  const withEnvironments = (body: () => void): void => {
    const current = effectiveDeploymentValues();
    setDeploymentValues({
      ...current,
      environments: {
        staging: {
          workerNames: { client: 'client-staging', api: 'api-staging' },
          d1DatabaseIds: { api: 'db-staging' },
        },
        production: {
          workerNames: { client: 'client-prod', api: 'api-prod' },
          d1DatabaseIds: { api: 'db-prod' },
        },
      },
    });
    try {
      body();
    } finally {
      setDeploymentValues(null);
    }
  };

  test('staging and production deploy different Worker names', () => {
    withEnvironments(() => {
      const staging = planFor(['api'], 'staging');
      const production = planFor(['api'], 'production');

      const nameOf = (steps: Step[]): string => {
        const index = steps[0]?.args.indexOf('--name') ?? -1;
        return steps[0]?.args[index + 1] ?? '';
      };

      expect(nameOf(staging)).toBe('api-staging');
      expect(nameOf(production)).toBe('api-prod');
      // The decisive assertion: the two plans are not the same plan.
      expect(staging[0]?.args).not.toEqual(production[0]?.args);
    });
  });

  test('an environment with no configured targets is refused, not defaulted', () => {
    const current = effectiveDeploymentValues();
    // Only staging exists. A production request must not be served by the single set.
    setDeploymentValues({
      ...current,
      environments: {
        staging: {
          workerNames: { client: 'client-staging', api: 'api-staging' },
          d1DatabaseIds: { api: 'db-staging' },
        },
      },
    });

    try {
      const plan = planDeploy(['api'], 'production', READY);

      expect(plan.ok).toBe(false);
      if (!plan.ok) {
        expect(plan.reason).toContain('production');
        // The remedy says what to write, not just that it is missing.
        expect(plan.remedy).toContain(LOCAL_DEPLOYMENT_FILE);
      }
    } finally {
      setDeploymentValues(null);
    }
  });
});
