// scripts/tests/deploy_process_boundary.test.ts
//
// The deploy command at its process boundary.
//
// The plan tests assert on `Step.args`. That is necessary and not sufficient: the
// defect this file exists for was not in the plan, it was in the gap between the
// plan and the process. `planDeploy` put `wrangler` in `args`, `runWrangler`
// prepended `wrangler`, and the process that ran was `wrangler wrangler deploy`.
//
// So this file substitutes the process runner and observes the argv the real one
// would spawn, plus whether anything was spawned at all. Nothing here reaches the
// network: `runBounded`/`setProcessRunner` replaces the spawn, and the consent
// gate is exercised with the credential absent and present.
//
// Migrated for the single-Worker deployment. The old file named two targets
// (`api`, `client`), resolved wrangler through the deleted API app's
// `node_modules`, and staged a build tree containing `build/index.html` — a
// static-site artifact, which is what the old split deployment produced. There is
// one target (`web`), wrangler is resolved through `apps/frontend/client`, and the
// artifact that must exist before a deploy is `.svelte-kit/cloudflare/_worker.js`.
// All three were changed together on purpose: keeping any one of the old shapes
// would have let a plan be built against an artifact that cannot exist.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ProcessRunner, setProcessRunner } from '../src/cloudflare/wrangler.ts';
import { deployCommand } from '../src/commands/deploy.ts';
import type { ConfigCheck } from '../src/deploy/configure.ts';
import { executePlan, parseDeployArgs, planDeploy, renderPlan } from '../src/deploy/deploy.ts';
import {
  effectiveDeploymentValues,
  setDeploymentValues,
} from '../src/registry/deployment_values.ts';

const READY: ConfigCheck = { ok: true, problems: [], notices: [] };

/**
 * A build tree with a compiled Worker, in a temp directory.
 *
 * `planDeploy` refuses a deploy whose `cloudflare/_worker.js` is absent, so a test
 * that plans one has to say which world it is in. Pointing it at the repository's own
 * build directory made this suite's result depend on whether someone had run
 * `bun run build` — green locally, failing in CI, where the unit-test step runs
 * before the build.
 */
const BUILD_WITH_WORKER = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'starter-boundary-build-'));
  mkdirSync(join(dir, 'cloudflare'), { recursive: true });
  writeFileSync(join(dir, 'cloudflare', '_worker.js'), 'export default {};\n', 'utf8');
  created.push(dir);
  return dir;
};

const created: string[] = [];

afterAll(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const savedWorkerName = effectiveDeploymentValues().workerName;
const savedToken = process.env.CLOUDFLARE_API_TOKEN;

interface Spawned {
  command: string;
  args: string[];
  cwd: string;
}

const recordSpawns = (
  runner: Partial<ProcessRunner> = {},
): { spawned: Spawned[]; runner: ProcessRunner } => {
  const spawned: Spawned[] = [];
  return {
    spawned,
    runner: {
      run(command, args, options) {
        spawned.push({ command, args: [...args], cwd: options.cwd });
        return runner.run?.(command, args, options) ?? 0;
      },
    },
  };
};

/**
 * Name the Worker for the duration of a test.
 *
 * Through the resolver seam, not by mutating the committed `DEPLOYMENT_CONFIG`.
 * `planDeploy` reads `targetsFor`, which reads the *resolved* values; a test that
 * wrote to the module production ignores is a test that proves nothing. That gap
 * is exactly how "every deploy test passed while `deploy:check` reported no Worker"
 * ever happened.
 */
const nameSet = (): void => {
  setDeploymentValues({ ...effectiveDeploymentValues(), workerName: 'test-web-worker' });
};

/**
 * A credential present.
 *
 * The consent gate reads `CLOUDFLARE_API_TOKEN` only, so a test that wants to
 * reach the *second* refusal — the one about `--yes` — has to supply one.
 */
const tokenSet = (): void => {
  process.env.CLOUDFLARE_API_TOKEN = 'test-token-not-a-real-credential';
};

const quiet = <T>(body: () => T): T => {
  const original = { out: process.stdout.write, err: process.stderr.write };
  // The command prints the plan it is about to run. That is useful to a human and
  // noise here, but suppressing it must not suppress the runner observation.
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return body();
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
};

afterEach(() => {
  setProcessRunner(null);
  // Clear the injection rather than restoring a snapshot: leaving values installed
  // leaks them into every later test file in this process, and a test that passes
  // because of another file's leftovers is not a test.
  setDeploymentValues(null);
  if (savedWorkerName !== null) {
    setDeploymentValues({ ...effectiveDeploymentValues(), workerName: savedWorkerName });
  }
  if (savedToken === undefined) {
    delete process.env.CLOUDFLARE_API_TOKEN;
  } else {
    process.env.CLOUDFLARE_API_TOKEN = savedToken;
  }
});

describe('the process boundary', () => {
  test('the spawned argv contains the wrangler token exactly once', () => {
    nameSet();
    tokenSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const plan = planDeploy(['web'], 'staging', READY, BUILD_WITH_WORKER());
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }

    quiet(() => executePlan(plan, 'staging', ['--yes']));

    expect(spawned).toHaveLength(1);
    const [call] = spawned;
    // The wrapper supplies the binary, so argv itself must not carry the token...
    expect(call?.args.filter((token) => token === 'wrangler')).toHaveLength(0);
    // ...and the executable it resolved is the pinned workspace copy, not a
    // network-fetched `bunx wrangler`. `apps/frontend/client` is where the Worker is
    // built and where wrangler is declared; the API app that used to answer this is
    // gone, and a path pointing at it would resolve to nothing at all.
    expect(call?.command.endsWith('wrangler')).toBe(true);
    expect(call?.command).toContain('apps/frontend/client/node_modules/.bin/wrangler');
    // Rendered as the process will actually be spawned: the wrangler executable path
    // is the only `wrangler` in the command line. The old defect produced two.
    const tokens = [call?.command, ...(call?.args ?? [])].join(' ').split(/\s+/);
    expect(tokens.filter((token) => /(?:^|\/)wrangler$/.test(token))).toHaveLength(1);
    expect(tokens[1]).toBe('deploy');
    expect(tokens.slice(2)).toEqual(call?.args.slice(1));
  });

  // One Worker means one `wrangler deploy`. Two targets meant a plan that could
  // half-succeed — Worker published, assets not — leaving a live deployment whose
  // pages 404, which nothing in the plan could name as a state to avoid.
  test('one target is one spawn, not one spawn per app in a list', () => {
    nameSet();
    tokenSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const plan = planDeploy(['web'], 'staging', READY, BUILD_WITH_WORKER());
    if (!plan.ok) {
      throw new Error(`expected a plan, got refusal: ${plan.reason}`);
    }
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.target).toBe('web');

    quiet(() => executePlan(plan, 'staging', ['--yes']));

    expect(spawned).toHaveLength(1);
  });

  test('a typo in the target starts no process at all', () => {
    nameSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const code = quiet(() => deployCommand.run(['webb', '--env', 'production', '--yes']));

    expect(code).toBe(2);
    expect(spawned).toEqual([]);
  });

  test('--env local starts no process at all', () => {
    nameSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const code = quiet(() => deployCommand.run(['web', '--env', 'local', '--yes']));

    expect(code).toBe(2);
    expect(spawned).toEqual([]);
  });

  test('an unknown flag starts no process at all', () => {
    nameSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const code = quiet(() => deployCommand.run(['web', '--forse', '--yes']));

    expect(code).toBe(2);
    expect(spawned).toEqual([]);
  });

  test('a dry run starts no process at all', () => {
    nameSet();
    tokenSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    // The template provisions nothing, so `main` reaches the real
    // `inspectConfig()` and refuses before it has a plan. That refusal is the
    // correct outcome and the property under test is unchanged: nothing spawned.
    const code = quiet(() => deployCommand.run(['web', '--env', 'production', '--dry-run']));

    expect(code).not.toBe(0);
    expect(spawned).toEqual([]);
  });

  // The previous version of this test called `parseDeployArgs` and `planDeploy` and
  // then asserted `parsed.dryRun === true`. That proved the flag parsed; it never
  // reached the branch the flag selects, so a regression in the dry-run path — the
  // one where output is printed instead of a process started — could not fail it.
  // The renderer is the same function `main` calls, so this asserts on what a real
  // dry run prints.
  test('a dry run against a ready config renders the plan and spawns nothing', () => {
    nameSet();
    tokenSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const parsed = parseDeployArgs(['web', '--env', 'production', '--dry-run']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.dryRun).toBe(true);

    const plan = planDeploy(parsed.targets, parsed.environment, READY, BUILD_WITH_WORKER());
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }

    const rendered = renderPlan(plan, parsed.environment);

    // What a dry run prints is the command a real run would spawn, so this is the
    // observable difference between the two paths rather than an internal flag.
    expect(rendered).toContain('wrangler deploy --env production');
    expect(rendered).toContain('Deploy the web Worker and its assets');
    expect(rendered).toContain(plan.steps[0]?.cwd ?? 'missing');
    // The notices a production deploy carries, rendered.
    expect(rendered).toContain('changes live traffic');
    expect(rendered).toContain(plan.notices.join('\n').slice(0, 40));

    // And the whole point: the dry-run branch renders, it does not execute.
    expect(spawned).toEqual([]);
  });

  test('missing --yes starts no process, even with a credential present', () => {
    nameSet();
    tokenSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const code = quiet(() => deployCommand.run(['web', '--env', 'production']));

    expect(code).toBe(1);
    expect(spawned).toEqual([]);
  });

  // The old behaviour: an interactive terminal was treated as consent, and
  // `requireRemoteConsent` only refused a *non-interactive* session without
  // `--yes`. So a developer at a prompt got a silent remote deploy.
  test('consent is not implied by an interactive terminal', async () => {
    tokenSet();
    const { requireRemoteConsent } = await import('../src/cloudflare/wrangler.ts');

    // `interactive: true` is exactly what a TTY looks like.
    expect(requireRemoteConsent('web', [], true).allowed).toBe(false);
    expect(requireRemoteConsent('web', ['--yes'], true).allowed).toBe(true);
    expect(requireRemoteConsent('web', ['--yes'], false).allowed).toBe(true);
  });

  test('no credential starts no process even with --yes', () => {
    nameSet();
    delete process.env.CLOUDFLARE_API_TOKEN;
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const code = quiet(() => deployCommand.run(['web', '--env', 'production', '--yes']));

    expect(code).toBe(1);
    expect(spawned).toEqual([]);
  });

  test('a failing step reports its exit code and nothing after it runs', () => {
    nameSet();
    tokenSet();
    const { spawned, runner } = recordSpawns({ run: () => 7 });
    setProcessRunner(runner);

    const plan = planDeploy(['web'], 'staging', READY, BUILD_WITH_WORKER());
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }

    const code = quiet(() => executePlan(plan, 'staging', ['--yes']));

    expect(code.code).toBe(7);
    // The plan has one step and it failed, so nothing else could have run. Asserted
    // on the count rather than on "the api failed so the client did not run", which
    // described a plan this deployment no longer has.
    expect(spawned).toHaveLength(1);
  });
});

describe('one plan, two consumers', () => {
  test('--dry-run and execution read the same plan', () => {
    nameSet();
    tokenSet();
    const parsed = parseDeployArgs(['web', '--env', 'production', '--dry-run']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const plan = planDeploy(parsed.targets, parsed.environment, READY, BUILD_WITH_WORKER());
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }

    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    quiet(() => executePlan(plan, parsed.environment, ['--yes']));

    // The plan object execution consumed is byte-identical to the one a dry run
    // printed: same steps, same args, same order, same working directory.
    expect(spawned[0]?.args).toEqual(plan.steps[0]?.args);
    expect(spawned[0]?.cwd).toBe(plan.steps[0]?.cwd);

    // And the rendered text carries that same argv, token for token — so the plan a
    // dry run shows is the plan a real run would execute, rather than a
    // restatement of it. `renderPlan` joins `step.command` with `step.args`, so a
    // mismatch here means the renderer and the process boundary disagree, which is
    // the defect this file was written for.
    const rendered = renderPlan(plan, parsed.environment);
    for (const step of plan.steps) {
      expect(rendered).toContain(`${step.command} ${step.args.join(' ')}`);
      expect(rendered).toContain(step.description);
    }
  });
});
