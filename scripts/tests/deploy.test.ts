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

const savedWorkerName = DEPLOYMENT_CONFIG.workerName;

/**
 * Set the Worker name for the duration of a test.
 *
 * This installs values through the resolver seam rather than mutating
 * `DEPLOYMENT_CONFIG`. The old version assigned to the committed module, which
 * production no longer reads — provisioning writes a gitignored overlay and the
 * environment, and the module is only the floor. That gap is why every test here
 * passed while `deploy:check` reported "no Worker name" for a project that had
 * provisioned one: the tests set the one value the code did not read.
 */
const setWorkerName = (name: string | null): void => {
  const current = effectiveDeploymentValues();
  setDeploymentValues({ ...current, workerName: name });
};

afterEach(() => {
  // Clear the injection rather than restoring a snapshot: leaving values
  // installed would leak into every later test file in this process, and a test
  // that passes because of another file's leftovers is not a test.
  setWorkerName(savedWorkerName);
  setDeploymentValues(null);
});

/**
 * Name the Worker for the duration of `body`.
 *
 * A remote deploy is refused unless a Worker name is configured, so a test about
 * step *contents* has to provision one. The name is obviously fake and is never
 * used for anything but satisfying the gate.
 */
const withWorkerName = <T>(body: () => T): T => {
  setWorkerName('test-web-worker');
  try {
    return body();
  } finally {
    setWorkerName(savedWorkerName);
  }
};

/**
 * Temp build trees, one with a compiled Worker and one without.
 *
 * `planDeploy` refuses a deploy whose `.svelte-kit/cloudflare/_worker.js` is
 * absent, so every test that plans a step has to say which world it is in. Reading
 * the real `.svelte-kit` directory made the suite depend on build state — see the
 * refusal test below for what that cost in CI.
 */
const makeBuildTree = (withWorker: boolean): string => {
  const dir = mkdtempSync(join(tmpdir(), 'starter-build-'));
  created.push(dir);
  if (withWorker) {
    mkdirSync(join(dir, 'cloudflare'), { recursive: true });
    writeFileSync(join(dir, 'cloudflare', '_worker.js'), 'export default {};\n', 'utf8');
  }
  return dir;
};

/** Temp build trees, removed when the file finishes. */
const created: string[] = [];

afterAll(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const BUILD_WITH_WORKER = makeBuildTree(true);
const BUILD_WITHOUT_WORKER = makeBuildTree(false);

/** A plan that is guaranteed to be built, or the test fails loudly. */
const planFor = (
  targets: readonly DeployTarget[],
  environment: 'staging' | 'production',
  config: ConfigCheck = READY,
): Step[] =>
  withWorkerName(() => {
    const plan = planDeploy(targets, environment, config, BUILD_WITH_WORKER);
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
  withWorkerName(() => {
    const plan = planDeploy(targets, environment, config, BUILD_WITH_WORKER);
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
    const plan = planDeploy(['web'], 'production');

    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).toBeTruthy();
    expect(plan.remedy).toContain('deploy:configure');
  });

  test('carries the problems from the config check into the refusal', () => {
    const plan = planDeploy(['web'], 'production', {
      ok: false,
      problems: ['No Cloudflare credential.', 'No D1 database id configured.'],
      notices: [],
    });

    if (plan.ok) {
      throw new Error('expected a refusal');
    }
    // The user should not have to re-run `deploy:configure --check` to find out
    // which of five things is wrong.
    expect(plan.reason).toContain('D1 database id');
  });

  test('refuses a remote deploy with no Worker name', () => {
    setWorkerName(null);

    const plan = planDeploy(['web'], 'staging', READY);

    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    // Naming the environment is what makes the message actionable.
    expect(plan.reason).toContain('staging');
    // And the remedy has to be a command that works. It used to say "Set
    // workerNames in packages/shared/schemas/src/registry/app_registry.ts", which
    // is a path that moved and a module `registry-valid` fails the build on when
    // it holds a literal id — so following the advice was impossible.
    expect(plan.remedy).toContain('deploy:configure');
    expect(plan.remedy).not.toContain('app_registry.ts');
  });

  // `local` was previously "not remote", which meant consent was skipped and a
  // `wrangler deploy` command was built anyway.
  test('refuses to plan a local deployment at all', () => {
    setWorkerName('test-web-worker');

    const plan = planDeploy(['web'], 'local' as 'staging', READY);

    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).toContain('not a deployable environment');
    expect(plan.remedy).toContain('bun run dev');
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
  // this command does not have. The local runtime is `bun run dev`.
  test('rejects --env local and points at the real local path', () => {
    const parsed = parseDeployArgs(['--env', 'local']);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors.join('\n')).toContain('bun run dev');
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
  test('defaults to the one target when no target word is given', () => {
    const parsed = parseDeployArgs([]);
    expect(parsed.ok && parsed.targets).toEqual(['web']);
  });

  test('accepts the target by name', () => {
    const parsed = parseDeployArgs(['web']);
    expect(parsed.ok && parsed.targets).toEqual(['web']);
  });

  test('deduplicates a repeated target', () => {
    // Otherwise a deploy runs twice, which for a deployment means a second upload
    // to live traffic.
    const parsed = parseDeployArgs(['web', 'web']);
    expect(parsed.ok && parsed.targets).toEqual(['web']);
  });

  // THE DEFECT: the previous `parseTargets` filtered argv down to tokens that
  // happened to be valid and defaulted to "both" when nothing survived, so `-- ap`
  // deployed the API *and* the client to production. With one target the shape of
  // the mistake changes rather than disappearing, so it is still asserted.
  test('an unknown target word is an error, not a deploy of everything', () => {
    for (const word of ['clientt', 'api', 'client']) {
      const parsed = parseDeployArgs([word]);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) {
        return;
      }
      expect(parsed.errors.join('\n')).toContain(`Unknown target "${word}"`);
    }
  });

  test('an unknown word among valid ones is still an error', () => {
    const parsed = parseDeployArgs(['web', 'databse']);
    expect(parsed.ok).toBe(false);
  });

  test('flags are not mistaken for targets', () => {
    const parsed = parseDeployArgs(['--dry-run', 'web', '--yes']);
    expect(parsed.ok && parsed.targets).toEqual(['web']);
  });

  test('a flag argument is not mistaken for a target', () => {
    // `--env production` — the value must not be read as a target word. It is not a
    // valid one, so this also proves the parse is order-sensitive rather than a
    // filter over every non-dash token.
    const parsed = parseDeployArgs(['--env', 'production']);
    expect(parsed.ok && parsed.targets).toEqual(['web']);
  });

  test('an unknown flag is an error', () => {
    const parsed = parseDeployArgs(['--forse', 'web']);
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
  test('produces one step', () => {
    // One application, one Worker, one step. Asserted as a length so a second
    // target reappearing in the plan is a failure here rather than something a
    // reviewer notices in a --dry-run.
    expect(planFor(['web'], 'production')).toHaveLength(1);
    expect(planFor(['web'], 'production').map((step) => step.target)).toEqual(['web']);
  });

  // THE DEFECT: `planDeploy` put `wrangler` in `args` and `runWrangler` prepended
  // it again, so the process that actually ran was `wrangler wrangler deploy`.
  test('args never contain the wrangler token', () => {
    for (const argv of argvOf(planFor(['web'], 'production'))) {
      expect(argv.filter((token) => token === 'wrangler')).toHaveLength(0);
    }
  });

  test('the first argument is the subcommand', () => {
    for (const argv of argvOf(planFor(['web'], 'production'))) {
      expect(argv[0]).toBe('deploy');
    }
  });

  test('the step deploys the Worker, not assets only', () => {
    // `--assets-only` against this config would publish the static files and no
    // server: every route, page and API call would 404, and the deploy would
    // report success. The Worker is the application.
    const [step] = planFor(['web'], 'production');
    expect(step?.args).not.toContain('--assets-only');
  });

  test('a deploy with no compiled Worker is refused, not published empty', () => {
    // `wrangler deploy` against a missing entrypoint does not fail loudly in every
    // case: it can publish an empty deployment, and the command reports success.
    // That is the failure this guards — a green deploy of nothing.
    //
    // A temp tree with no `cloudflare/_worker.js`, rather than the repository's
    // own. The first version of this test renamed the real build output aside and
    // restored it afterwards, which meant the suite's result depended on whether
    // someone had run `bun run build`: green locally, and three failures in CI,
    // where the unit-test step runs before the build. A test that asserts against
    // the repository is asserting against whoever cloned it last.
    const plan = withWorkerName(() =>
      planDeploy(['web'], 'production', READY, BUILD_WITHOUT_WORKER),
    );

    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toContain('build output');
      expect(plan.remedy).toContain('bun run build');
    }
  });

  test('a deploy with a compiled Worker is planned, so the refusal above is about the artifact', () => {
    // The other half of the pair. Without this, a check that refused *everything*
    // would satisfy the test above.
    expect(planFor(['web'], 'production')).toHaveLength(1);
  });

  test('the step names its config, which now exists', () => {
    // It used to pass no `--config` for one of the two apps, because that
    // directory had no wrangler config: `deploy --client` ran `--assets-only`
    // against nothing and wrangler fell back to its own defaults. The assertion
    // was written to pin that behaviour, so it was green while the deploy could not
    // work.
    const [step] = planFor(['web'], 'production');
    expect(step?.args).toContain('--config');

    const configIndex = step?.args.indexOf('--config') ?? -1;
    expect(step?.args[configIndex + 1]).toContain('wrangler.jsonc');
    // And the file it names is really there, relative to the step's cwd.
    expect(existsSync(join(CLIENT_DIR, 'wrangler.jsonc'))).toBe(true);
  });

  test('the step carries the Worker name the plan printed', () => {
    // Otherwise the name in the plan is a description of one thing and the deploy
    // is another: a config carrying its own name would make `deploy:check` lie
    // about what would be published.
    const [step] = planFor(['web'], 'production');
    const nameIndex = step?.args.indexOf('--name') ?? -1;
    expect(nameIndex).toBeGreaterThan(-1);
    expect(step?.args[nameIndex + 1]).toBe('test-web-worker');
  });

  test('a remote step always carries its environment', () => {
    for (const environment of ['staging', 'production'] as const) {
      const [step] = planFor(['web'], environment);
      expect(step?.args).toContain('--env');
      expect(step?.args).toContain(environment);
    }
  });

  test('the step runs in the application directory, where its config lives', () => {
    const [step] = planFor(['web'], 'production');
    expect(step?.cwd).toBe(CLIENT_DIR);
  });

  test('carries a human description as well as a command', () => {
    for (const step of planFor(['web'], 'production')) {
      expect(step.description).toContain(step.target);
      expect(step.description).toContain('production');
    }
  });
});

describe('planDeploy: the consent gate', () => {
  test('the step is remote, because every deployable environment is remote', () => {
    // A production step marked non-remote would deploy to live traffic with no
    // confirmation. There is no longer a non-remote deploy path.
    for (const environment of ['staging', 'production'] as const) {
      for (const step of planFor(['web'], environment)) {
        expect(step.remote).toBe(true);
      }
    }
  });
});

describe('planDeploy: what it will never do', () => {
  test('no source-publication command', () => {
    // Publishing is a different action with different consequences. If it ever
    // appears in a deploy plan, `bun run deploy` would push a repository.
    for (const command of argvTextOf(planFor(['web'], 'production'))) {
      expect(command).not.toContain('git push');
      expect(command).not.toContain('gh release');
      expect(command).not.toContain('npm publish');
    }
  });

  test('no provisioning command', () => {
    // Creating a database or bucket is not deploying, and is not undone by
    // removing the deploy.
    for (const command of argvTextOf(planFor(['web'], 'production'))) {
      expect(command).not.toContain('d1 create');
      expect(command).not.toContain('r2 bucket create');
      expect(command).not.toContain('d1 execute');
    }
  });

  test('no migration command', () => {
    // Migrations change a database's shape. Running them as part of a deploy would
    // make a code rollback insufficient to undo a failed release.
    for (const command of argvTextOf(planFor(['web'], 'production'))) {
      expect(command).not.toContain('migrate');
      expect(command).not.toContain('db:');
    }
  });

  test('no credential appears in a command', () => {
    for (const command of argvTextOf(planFor(['web'], 'production'))) {
      expect(command).not.toMatch(/CLOUDFLARE_API_TOKEN=\S/);
      expect(command).not.toMatch(/--api-token\s+\S/);
    }
  });

  test('no command deletes or removes anything', () => {
    for (const command of argvTextOf(planFor(['web'], 'production'))) {
      expect(command).not.toContain('delete');
      expect(command).not.toContain('rm ');
      expect(command).not.toContain('--force');
    }
  });

  test('an unknown target is refused, not deployed', () => {
    // `parseDeployArgs` rejects one, but `planDeploy` is exported and callers
    // (including these tests) pass arrays directly. A plan built from an
    // unvalidated string would be a deploy command for a nonexistent app.
    setWorkerName('test-web-worker');

    expect(planDeploy(['database' as DeployTarget], 'production', READY).ok).toBe(false);
  });
});

describe('planDeploy: notices', () => {
  test('always states that a deploy is not a source publication', () => {
    // The distinction this tool exists to make. A user who believes otherwise will
    // act on the belief — most visibly by expecting `git` to have run.
    for (const environment of ['staging', 'production'] as const) {
      expect(planForFull(['web'], environment).notices.join('\n')).toContain('does not publish');
    }
  });

  test('always states that it creates no resources', () => {
    for (const environment of ['staging', 'production'] as const) {
      expect(planForFull(['web'], environment).notices.join('\n')).toContain('create');
    }
  });

  test('warns that a production deploy changes live traffic', () => {
    expect(planForFull(['web'], 'production').notices.join('\n')).toContain('live traffic');
  });

  test('does not raise a live-traffic warning for staging', () => {
    // Staging traffic is also real to whoever looks at it, but the wording is
    // reserved for the one case where the warning must not be missed.
    expect(planForFull(['web'], 'staging').notices.join('\n')).not.toContain('live traffic');
  });

  test('carries forward the notices from the config check', () => {
    const plan = planForFull(['web'], 'production', {
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
        staging: { workerName: 'staging-web', d1DatabaseId: 'db-staging' },
        production: { workerName: 'prod-web', d1DatabaseId: 'db-prod' },
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
      const staging = planFor(['web'], 'staging');
      const production = planFor(['web'], 'production');

      const nameOf = (steps: Step[]): string => {
        const index = steps[0]?.args.indexOf('--name') ?? -1;
        return steps[0]?.args[index + 1] ?? '';
      };

      expect(nameOf(staging)).toBe('staging-web');
      expect(nameOf(production)).toBe('prod-web');
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
        staging: { workerName: 'staging-web', d1DatabaseId: 'db-staging' },
      },
    });

    try {
      const plan = planDeploy(['web'], 'production', READY);

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
