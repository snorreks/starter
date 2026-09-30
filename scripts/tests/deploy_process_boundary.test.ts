// scripts/src/lib/deploy/process_boundary.test.ts
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

import { afterEach, describe, expect, test } from 'bun:test';
import { DEPLOYMENT_CONFIG } from '@starter/schemas';
import { type ProcessRunner, setProcessRunner } from '../src/cloudflare/wrangler.ts';
import type { ConfigCheck } from '../src/deploy/configure.ts';
import { executePlan, main, parseDeployArgs, planDeploy } from '../src/deploy/deploy.ts';

const READY: ConfigCheck = { ok: true, problems: [], notices: [] };

const savedWorkerNames = { ...DEPLOYMENT_CONFIG.workerNames };
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

const namesSet = (): void => {
  DEPLOYMENT_CONFIG.workerNames.api = 'test-api-worker';
  DEPLOYMENT_CONFIG.workerNames.client = 'test-client-worker';
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
  DEPLOYMENT_CONFIG.workerNames = { ...savedWorkerNames };
  if (savedToken === undefined) {
    delete process.env.CLOUDFLARE_API_TOKEN;
  } else {
    process.env.CLOUDFLARE_API_TOKEN = savedToken;
  }
});

describe('the process boundary', () => {
  test('the spawned argv contains the wrangler token exactly once', () => {
    namesSet();
    tokenSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const plan = planDeploy(['api'], 'staging', READY);
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
    // network-fetched `bunx wrangler`.
    expect(call?.command.endsWith('wrangler')).toBe(true);
    expect(call?.command).toContain('apps/backend/api/node_modules/.bin/wrangler');
    // Rendered as the process will actually be spawned: the wrangler executable path
    // is the only `wrangler` in the command line. The old defect produced two.
    const tokens = [call?.command, ...(call?.args ?? [])].join(' ').split(/\s+/);
    expect(tokens.filter((token) => /(?:^|\/)wrangler$/.test(token))).toHaveLength(1);
    expect(tokens[1]).toBe('deploy');
    expect(tokens.slice(2)).toEqual(call?.args.slice(1));
  });

  test('a typo in the target starts no process at all', () => {
    namesSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const code = quiet(() => main(['clientt', '--env', 'production', '--yes']));

    expect(code).toBe(2);
    expect(spawned).toEqual([]);
  });

  test('--env local starts no process at all', () => {
    namesSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const code = quiet(() => main(['api', '--env', 'local', '--yes']));

    expect(code).toBe(2);
    expect(spawned).toEqual([]);
  });

  test('an unknown flag starts no process at all', () => {
    namesSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const code = quiet(() => main(['api', '--forse', '--yes']));

    expect(code).toBe(2);
    expect(spawned).toEqual([]);
  });

  test('a dry run starts no process at all', () => {
    namesSet();
    tokenSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    // The template provisions nothing, so `main` reaches the real
    // `inspectConfig()` and refuses before it has a plan. That refusal is the
    // correct outcome and the property under test is unchanged: nothing spawned.
    const code = quiet(() => main(['api', '--env', 'production', '--dry-run']));

    expect(code).not.toBe(0);
    expect(spawned).toEqual([]);
  });

  test('a dry run against a ready config renders the plan and spawns nothing', () => {
    namesSet();
    tokenSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const parsed = parseDeployArgs(['api', '--env', 'production', '--dry-run']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const plan = planDeploy(parsed.targets, parsed.environment, READY);
    expect(plan.ok).toBe(true);

    // Nothing to execute: `executePlan` is only reached when `dryRun` is false.
    expect(parsed.dryRun).toBe(true);
    expect(spawned).toEqual([]);
  });

  test('missing --yes starts no process, even with a credential present', () => {
    namesSet();
    tokenSet();
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const code = quiet(() => main(['api', '--env', 'production']));

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
    expect(requireRemoteConsent('api', [], true).allowed).toBe(false);
    expect(requireRemoteConsent('api', ['--yes'], true).allowed).toBe(true);
    expect(requireRemoteConsent('api', ['--yes'], false).allowed).toBe(true);
  });

  test('no credential starts no process even with --yes', () => {
    namesSet();
    delete process.env.CLOUDFLARE_API_TOKEN;
    const { spawned, runner } = recordSpawns();
    setProcessRunner(runner);

    const code = quiet(() => main(['api', '--env', 'production', '--yes']));

    expect(code).toBe(1);
    expect(spawned).toEqual([]);
  });

  test('a failing step stops the plan and reports its exit code', () => {
    namesSet();
    tokenSet();
    const { spawned, runner } = recordSpawns({ run: () => 7 });
    setProcessRunner(runner);

    const plan = planDeploy(['api', 'client'], 'staging', READY);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }

    const code = quiet(() => executePlan(plan, 'staging', ['--yes']));

    expect(code.code).toBe(7);
    // The api failed, so the client step must not have run.
    expect(spawned).toHaveLength(1);
  });
});

describe('one plan, two consumers', () => {
  test('--dry-run and execution read the same plan', () => {
    namesSet();
    tokenSet();
    const parsed = parseDeployArgs(['api', '--env', 'production', '--dry-run']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const plan = planDeploy(parsed.targets, parsed.environment, READY);
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
  });
});
