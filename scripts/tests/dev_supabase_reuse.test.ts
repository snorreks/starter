// scripts/tests/dev_supabase_reuse.test.ts
//
// Reusing the local development database.
//
// The failure this exists to prevent is a *silent* one: a `bun run dev` that boots
// its own thirty-second stack when a perfectly good database is already running, or
// worse, adopts something that is not a database and serves 503s with no
// explanation. Both look like "dev is slow" and neither is caught by a test that
// only asserts the happy path.
//
// What is asserted here:
//   * the run id is stable across calls and derived from the checkout, not the pid
//   * an adoption is skipped unless this checkout's own stack is provably up
//   * a reused stack reports that it is reused, and is not stopped at teardown
//   * the lanes that need a pristine database are unaffected by the sharing

import { describe, expect, test } from 'bun:test';
import {
  allocateSupabaseLocal,
  DEV_SHARED_STACK_RUN_ID,
  devSupabaseAllocation,
  type SupabaseLocalAllocation,
} from '../src/db/supabase_local.ts';
import { prepareSupabaseService } from '../src/local/supabase_service.ts';
import { recordingProgress } from './fixtures/progress.ts';

const allocation = {
  projectId: 'stdevshared000000000',
  runId: DEV_SHARED_STACK_RUN_ID,
  ownerToken: 'a'.repeat(48),
  root: '/owned/dev_local',
  ports: {
    api: 55_609,
    postgres: 55_610,
    studio: 55_611,
    mail: 55_612,
    smtp: 55_613,
    pop3: 55_614,
  },
  urls: {
    api: 'http://127.0.0.1:55609',
    postgres: 'postgresql://postgres:postgres@127.0.0.1:55610/postgres',
    studio: 'http://127.0.0.1:55611',
    mail: 'http://127.0.0.1:55612',
    smtp: '127.0.0.1:55613',
    pop3: '127.0.0.1:55614',
  },
} as unknown as SupabaseLocalAllocation;

const RUNNING = {
  SUPABASE_URL: 'http://127.0.0.1:55609',
  SUPABASE_ANON_KEY: 'running-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'running-service-role',
};

const recorder = (probe: () => Promise<Record<string, string> | null>) => {
  const calls: string[] = [];
  const dependencies = {
    allocate: (): SupabaseLocalAllocation => {
      calls.push('allocate');
      return allocation;
    },
    probe: async (): Promise<Record<string, string> | null> => {
      calls.push('probe');
      return probe();
    },
    start: (async () => {
      calls.push('start');
      return { ...RUNNING, SUPABASE_ANON_KEY: 'fresh-anon' };
    }) as never,
    seed: (async () => {
      calls.push('seed');
      return { userId: 'u', noteCount: 2 };
    }) as never,
    hasOwnership: (async () => false) as never,
    readOwnership: (async () => allocation) as never,
    stop: (async () => {
      calls.push('stop');
      return [];
    }) as never,
    // Empty, because these tests are about adoption. The real collaborators read
    // `docker volume ls`, and a reuse test that needed a container engine would be
    // a reuse test nobody runs; `dev_supabase_persistence.test.ts` covers these two.
    listVolumes: ((): string[] => {
      calls.push('listVolumes');
      return [];
    }) as never,
    discard: ((): string[] => {
      calls.push('discard');
      return [];
    }) as never,
  };
  return { calls, dependencies };
};

const service = (probe: () => Promise<Record<string, string> | null>, reuse?: boolean) =>
  prepareSupabaseService({
    origin: 'http://127.0.0.1:5173',
    callerVars: {},
    autoSignIn: true,
    reuse,
    progress: recordingProgress().progress,
    dependencies: recorder(probe).dependencies,
  });

describe('the development database is one per checkout, not one per process', () => {
  test('two allocations of it are the same project on the same ports', () => {
    // The defect this prevents: with a pid in the id, run 1 and run 2 computed
    // different projects, so run 2 could never find run 1's database and booted its
    // own — thirty seconds, and then two stacks to attribute a port to.
    const first = devSupabaseAllocation('/checkout');
    const second = devSupabaseAllocation('/checkout');

    expect(second.projectId).toBe(first.projectId);
    expect(second.ports).toEqual(first.ports);
    expect(second.urls).toEqual(first.urls);
  });

  test('two checkouts still get different databases', () => {
    // The reason this is derived from the root rather than hardcoded: two worktrees
    // on one machine are two developers' checkouts, and sharing one database
    // between them would let one checkout's rows into the other's assertions.
    expect(devSupabaseAllocation('/checkout-a').projectId).not.toBe(
      devSupabaseAllocation('/checkout-b').projectId,
    );
  });

  test('the lanes that need a pristine database allocate their own', () => {
    // E2E, test:worker and test:database all pass a unique run id. If any of them
    // inherited this one, a second run would assert against the first run's rows.
    const lane = allocateSupabaseLocal('/checkout', 'e2e_abc');
    expect(lane.projectId).not.toBe(devSupabaseAllocation('/checkout').projectId);
    expect(lane.runId).toBe('e2e_abc');
  });
});

describe('a database already running is adopted, not started again', () => {
  test('nothing is started, migrated or seeded when one is there', async () => {
    const rec = recorder(async () => RUNNING);
    const prepared = await prepareSupabaseService({
      origin: 'http://127.0.0.1:5173',
      callerVars: {},
      autoSignIn: true,
      progress: recordingProgress().progress,
      dependencies: rec.dependencies,
    });

    // `start` would be thirty seconds of container boot; `seed` would write into a
    // database this run does not own.
    expect(rec.calls).toEqual(['allocate', 'probe']);
    expect(prepared.vars.SUPABASE_ANON_KEY).toBe('running-anon');
    expect(prepared.label).toContain('reused');
  });

  test('the banner says it was reused and that it will outlive the run', async () => {
    const prepared = await service(async () => RUNNING);
    const said = prepared.summary.join('\n');

    // A developer who does not know the database survives has no reason not to run
    // `db:stop`, and then the next run is slow again with no explanation.
    expect(said).toContain('already running');
    expect(said).toContain('db:stop');
  });

  test('a reused stack is not stopped when the run ends', async () => {
    const rec = recorder(async () => RUNNING);
    const prepared = await prepareSupabaseService({
      origin: 'http://127.0.0.1:5173',
      callerVars: {},
      autoSignIn: true,
      progress: recordingProgress().progress,
      dependencies: rec.dependencies,
    });

    expect(await prepared.dispose()).toEqual([]);
    // Stopping it here is what made the feature useless: the next run would boot a
    // fresh thirty-second stack over the top of the one it had just reclaimed.
    expect(rec.calls).not.toContain('stop');
  });

  test('a reused stack still signs the developer in, because it was seeded', () => {
    // The bindings come from the reused database, which this run did not seed — so
    // without the auto-sign-in vars the first page would be a login form every
    // time, which is the opposite of what reuse is for.
    return service(async () => RUNNING).then((prepared) => {
      expect(prepared.vars.DEV_AUTO_LOGIN).toBe('seed');
      expect(prepared.vars.DEV_AUTO_LOGIN_EMAIL).toContain('@');
    });
  });
});

describe("nothing is adopted unless it is provably this checkout's own", () => {
  test('no running database means the full start, exactly as before', async () => {
    const rec = recorder(async () => null);
    await prepareSupabaseService({
      origin: 'http://127.0.0.1:5173',
      callerVars: {},
      autoSignIn: true,
      progress: recordingProgress().progress,
      dependencies: rec.dependencies,
    });

    expect(rec.calls).toEqual(['allocate', 'probe', 'listVolumes', 'start', 'seed']);
  });

  test('a probe that reports nothing is treated as absent, not as a failure', async () => {
    // `probeRunningSupabase` returns null for every "I cannot prove this is ours":
    // no ownership file, an unparseable one, a CLI that exits nonzero, a stack
    // belonging to another project. The service must start a fresh one in all of
    // those cases rather than propagate the doubt as an error.
    for (const absent of [null, undefined]) {
      const rec = recorder(async () => absent ?? null);
      const prepared = await prepareSupabaseService({
        origin: 'http://127.0.0.1:5173',
        callerVars: {},
        autoSignIn: true,
        progress: recordingProgress().progress,
        dependencies: rec.dependencies,
      });
      expect(prepared.label).not.toContain('reused');
    }
  });

  test('reuse can be turned off for a caller that needs a clean database', async () => {
    // A test asserting on seeded state, or anyone debugging "why is my row still
    // here", needs to opt out. An option nobody can reach is not an option.
    const rec = recorder(async () => RUNNING);
    await prepareSupabaseService({
      origin: 'http://127.0.0.1:5173',
      callerVars: {},
      autoSignIn: true,
      reuse: false,
      progress: recordingProgress().progress,
      dependencies: rec.dependencies,
    });

    expect(rec.calls).toEqual(['allocate', 'listVolumes', 'start', 'seed']);
  });

  test('a stack this run started reports that it will be left running', async () => {
    const prepared = await service(async () => null);
    // The one case where containers outlive the command is stated in the banner,
    // rather than discovered later as an unexpected `docker ps`.
    expect(prepared.summary.join('\n')).toContain('db:stop');
  });
});

describe('the shared identity cannot be forged by another checkout', () => {
  test('the owner token differs between checkouts', () => {
    // It is what `assertSupabaseOwnership` checks before anything is stopped, so a
    // token derived from the root means one checkout cannot authorise itself to
    // tear down another's database.
    expect(devSupabaseAllocation('/checkout-a').ownerToken).not.toBe(
      devSupabaseAllocation('/checkout-b').ownerToken,
    );
  });

  test('it is not a random value that no later run could reproduce', () => {
    // A random token would make a reused stack unrecognisable: the next run would be
    // holding an allocation whose recorded owner is a token nobody can recreate,
    // and the identity assertion would refuse to stop it.
    expect(devSupabaseAllocation('/checkout').ownerToken).toBe(
      devSupabaseAllocation('/checkout').ownerToken,
    );
    expect(devSupabaseAllocation('/checkout').ownerToken.length).toBeGreaterThanOrEqual(32);
  });
});

describe('a failed start is still cleaned up', () => {
  test('the stack a failed run started does not outlive it', async () => {
    // Reuse deliberately leaves a healthy database behind. It must not extend to a
    // half-started one: those hold ports and answer nothing.
    const rec = recorder(async () => null);
    const stopped: string[] = [];
    const dependencies = {
      ...rec.dependencies,
      seed: (async () => {
        throw new Error('seed failed');
      }) as never,
      hasOwnership: (async () => true) as never,
      stop: (async () => {
        stopped.push('stop');
        return [];
      }) as never,
    };

    await expect(
      prepareSupabaseService({
        origin: 'http://127.0.0.1:5173',
        callerVars: {},
        autoSignIn: true,
        progress: recordingProgress().progress,
        dependencies,
      }),
    ).rejects.toThrow('seed failed');
    // The whole point of this case: the catch block around start-and-seed tears the
    // stack down even though the success path no longer does. Without it a failed
    // boot would leave containers behind and the next run would adopt them.
    expect(stopped).toEqual(['stop']);
  });
});
