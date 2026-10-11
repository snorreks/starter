// scripts/tests/dev_supabase_persistence.test.ts
//
// Keeping the local development database's data, and throwing it away on purpose.
//
// The failure this exists to prevent is the quiet one. `db:stop` that deletes a
// developer's local rows is destructive and nobody asked for it; a `--fresh` that
// keeps them is worse, because the developer asked for a clean database to debug
// something and got yesterday's rows with a "fresh" label in the banner. Neither
// shows up as an error, and a test that only asserts the happy path cannot tell the
// two apart from a correct implementation.
//
// What is asserted here:
//   * a stop that is asked to keep the data runs no `volume rm`, and says so
//   * a stop that is not asked — every lane's default — still removes the volumes,
//     because one leaked volume set per E2E run is a defect nobody would report
//   * `--fresh` never adopts a running stack, stops it, and removes the volumes a
//     previous `db:stop` kept, so "fresh" cannot mean "restored"
//   * a normal boot says whether it restored data, so yesterday's rows on the first
//     screen are explained rather than mysterious
//   * a stack that failed to start keeps nothing, so the next run cannot restore a
//     database nobody ever reached
//
// The container engine is injected (`SupabaseRuntime`), which is the point: these
// assertions read the argv that *would* have been spawned, so "it kept the volume"
// is observed rather than assumed. No test here needs Docker.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFreshFlag } from '../src/commands/dev.ts';
import {
  type ContainerRun,
  devSupabaseAllocation,
  discardSupabaseData,
  preservedSupabaseVolumes,
  type SupabaseLocalAllocation,
  type SupabaseRuntime,
  stopDevSupabaseLocal,
  stopSupabaseLocal,
} from '../src/db/supabase_local.ts';
import { prepareSupabaseService } from '../src/local/supabase_service.ts';
import { recordingProgress } from './fixtures/progress.ts';

const PROJECT = 'stpersisted00000000';

/**
 * A container engine that records what it was asked.
 *
 * `volumes` is what the engine claims to hold, so a test can put a volume there and
 * then assert whether the teardown removed it — which is the behaviour, rather than
 * a proxy for it.
 */
const fakeEngine = (
  volumes: readonly string[] = [],
  containers: readonly string[] = [],
  project = PROJECT,
) => {
  const argv: string[][] = [];
  let held = [...volumes];
  let running = [...containers];

  const run = (args: readonly string[]): ContainerRun => {
    argv.push([...args]);
    const verb = args[0];
    if (verb === 'volume' && args[1] === 'ls') {
      return { status: 0, stdout: `${held.join('\n')}\n`, stderr: '' };
    }
    if (verb === 'volume' && args[1] === 'rm') {
      held = held.filter((name) => !args.slice(2).includes(name));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (verb === 'ps') {
      expect(args).toEqual(['ps', '-aq', '--filter', `label=com.supabase.cli.project=${project}`]);
      return { status: 0, stdout: running.join('\n'), stderr: '' };
    }
    if (verb === 'rm') {
      running = running.filter((id) => !args.slice(2).includes(id));
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected engine command: ${args.join(' ')}`);
  };

  const runtime: SupabaseRuntime = { command: 'fake-engine', run };
  return {
    runtime,
    argv,
    /** What the engine still holds. The assertion that matters. */
    held: () => [...held],
    /** Did anything ask to remove these volumes? */
    removedVolume: (name: string): boolean =>
      argv.some((call) => call[0] === 'volume' && call[1] === 'rm' && call.includes(name)),
  };
};

const allocation = (overrides: Partial<SupabaseLocalAllocation> = {}) =>
  ({
    projectId: PROJECT,
    runId: 'dev_local',
    ownerToken: 'a'.repeat(48),
    containerCommand: 'fake-engine',
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
    ...overrides,
  }) as SupabaseLocalAllocation;

const DB_VOLUME = `supabase_db_${PROJECT}`;

describe('stopping the development database keeps the data when it is asked to', () => {
  test('a preserving stop runs no volume rm and says what it kept', async () => {
    // The whole feature in one assertion: containers go, the volume stays. If the
    // `volume rm` below comes back, `db:stop` has deleted a developer's local data
    // again — silently, because `docker volume rm` is not a thing anybody sees.
    const engine = fakeEngine([DB_VOLUME]);
    const said: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown): boolean => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await stopSupabaseLocal(allocation(), allocation(), {
        preserveData: true,
        runtime: engine.runtime,
      });
    } finally {
      process.stdout.write = original;
    }

    expect(engine.removedVolume(DB_VOLUME)).toBe(false);
    expect(engine.held()).toEqual([DB_VOLUME]);
    // Named, because "your rows are still there" is invisible from a diff of
    // containers that went away.
    expect(said.join('')).toContain(DB_VOLUME);
  });

  test('a stop that was not asked still removes the volumes', async () => {
    // The default, and the reason it is the default: every lane tears down through
    // this function under a unique project id. A `true` default would leave one
    // volume set per E2E run on the machine, forever.
    const engine = fakeEngine([DB_VOLUME]);
    await stopSupabaseLocal(allocation(), allocation(), { runtime: engine.runtime });

    expect(engine.removedVolume(DB_VOLUME)).toBe(true);
    expect(engine.held()).toEqual([]);
  });
});

describe('the volumes a stopped stack left behind are visible to the next run', () => {
  test('they are found by the project label, not by a file this repository wrote', () => {
    // A marker file records what a previous run *intended*; the engine answers what
    // is actually there, which is the only answer that survives a reboot.
    const engine = fakeEngine([DB_VOLUME]);
    expect(preservedSupabaseVolumes(allocation(), { runtime: engine.runtime })).toEqual([
      DB_VOLUME,
    ]);
    expect(engine.argv[0]?.[4]).toBe(`label=com.supabase.cli.project=${PROJECT}`);
  });

  test('discarding removes exactly this checkout volumes, and reports them', () => {
    const engine = fakeEngine([DB_VOLUME, `supabase_storage_${PROJECT}`]);
    const removed = discardSupabaseData(allocation(), { runtime: engine.runtime });

    expect(removed).toEqual([DB_VOLUME, `supabase_storage_${PROJECT}`]);
    expect(engine.held()).toEqual([]);
  });

  test('an engine that cannot answer is a failure, not an empty list', () => {
    // `[]` here would mean "there is no data to restore", and the next start would
    // quietly be an empty database on top of somebody's existing one.
    const runtime: SupabaseRuntime = {
      command: 'fake-engine',
      run: () => ({ status: 1, stdout: '', stderr: 'cannot connect to the daemon' }),
    };
    expect(() => preservedSupabaseVolumes(allocation(), { runtime })).toThrow(
      /Cannot verify owned Supabase volumes/,
    );
  });
});

// --- the service half: what `--fresh` does -------------------------------

const RUNNING = {
  SUPABASE_URL: 'http://127.0.0.1:55609',
  SUPABASE_ANON_KEY: 'running-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'running-service-role',
};

const serviceHarness = (
  options: { running?: boolean; owned?: boolean; volumes?: string[] } = {},
) => {
  const calls: string[] = [];
  const stack = allocation();
  const dependencies = {
    allocate: (): SupabaseLocalAllocation => {
      calls.push('allocate');
      return stack;
    },
    probe: async (): Promise<Record<string, string> | null> => {
      calls.push('probe');
      return options.running === true ? { ...RUNNING } : null;
    },
    start: (async () => {
      calls.push('start');
      return { ...RUNNING, SUPABASE_ANON_KEY: 'fresh-anon' };
    }) as never,
    seed: (async () => {
      calls.push('seed');
      return { userId: 'u', noteCount: 2 };
    }) as never,
    hasOwnership: (async () => {
      calls.push('hasOwnership');
      return options.owned !== false;
    }) as never,
    readOwnership: (async () => stack) as never,
    stop: (async (_allocation: SupabaseLocalAllocation, _owned: unknown, stopOptions?: unknown) => {
      calls.push(`stop:${JSON.stringify(stopOptions ?? {})}`);
      return [];
    }) as never,
    listVolumes: ((): string[] => {
      calls.push('listVolumes');
      return options.volumes ?? [];
    }) as never,
    discard: ((): string[] => {
      calls.push('discard');
      return options.volumes ?? [];
    }) as never,
  };
  return { calls, dependencies, stack };
};

const freshService = (harness: ReturnType<typeof serviceHarness>) =>
  prepareSupabaseService({
    origin: 'http://127.0.0.1:5173',
    callerVars: {},
    autoSignIn: true,
    fresh: true,
    progress: recordingProgress().progress,
    dependencies: harness.dependencies,
  });

describe('a fresh start is a database with nothing of the last one in it', () => {
  test('it never adopts a running stack', async () => {
    // Adoption is the opposite of what was asked for. A fresh boot that reused the
    // running database would report "fresh" and hold yesterday's rows.
    const harness = serviceHarness({ running: true });
    const prepared = await freshService(harness);

    expect(prepared.label).toBe('Local Supabase');
    expect(prepared.label).not.toContain('reused');
    expect(prepared.summary.join('\n')).toContain('fresh database');
    expect(harness.calls).toContain('start');
    // The bindings are the new stack's, not the running one's.
    expect(prepared.vars.SUPABASE_ANON_KEY).toBe('fresh-anon');
  });

  test('it stops a running stack, and stops it without keeping the data', async () => {
    // Order matters and is asserted by the sequence: `stop` before `discard`,
    // because the engine refuses to remove a mounted volume — which would report as
    // "the fresh start failed" on a host whose engine is working fine.
    const harness = serviceHarness({ running: true });
    await freshService(harness);

    expect(harness.calls).toEqual([
      'allocate',
      'hasOwnership',
      'stop:{"preserveData":false}',
      'discard',
      'listVolumes',
      'start',
      'seed',
    ]);
  });

  test('an unhealthy owned stack is stopped before its volumes are discarded', async () => {
    const harness = serviceHarness({ running: false });
    await freshService(harness);
    expect(harness.calls).not.toContain('probe');
    expect(harness.calls.indexOf('stop:{"preserveData":false}')).toBeLessThan(
      harness.calls.indexOf('discard'),
    );
    expect(harness.calls).toContain('stop:{"preserveData":false}');
  });

  test('it removes the volumes a previous db:stop kept', async () => {
    // The case that makes `--fresh` mean anything after this feature: without the
    // discard, `supabase start` reattaches the kept volume and the "fresh" database
    // is the previous one.
    const harness = serviceHarness({ owned: false, volumes: [DB_VOLUME] });
    await freshService(harness);

    expect(harness.calls).toContain('discard');
    expect(harness.calls.indexOf('discard')).toBeLessThan(harness.calls.indexOf('start'));
  });

  test('a database this checkout never started is not stopped', async () => {
    // With no ownership record, discard recovers containers by project label;
    // the CLI stop must not run against a missing work directory.
    const harness = serviceHarness({ owned: false });
    await freshService(harness);

    expect(harness.calls.some((call) => call.startsWith('stop:'))).toBe(false);
    // `listVolumes` still runs on a fresh start: it reports the empty list a
    // `discard` seconds ago produced, so the banner cannot claim a restore.
    expect(harness.calls).toEqual([
      'allocate',
      'hasOwnership',
      'discard',
      'listVolumes',
      'start',
      'seed',
    ]);
  });

  test('a fresh start still seeds, because a seeded account is the point of it', async () => {
    const harness = serviceHarness();
    const prepared = await freshService(harness);

    expect(harness.calls).toContain('seed');
    expect(prepared.summary.join('\n')).toContain('Seeded account');
    expect(prepared.vars.DEV_AUTO_LOGIN).toBe('seed');
  });
});

describe('an ordinary start says whether it brought the data back', () => {
  test('a restored volume is named, and the way to start over is given', async () => {
    // Silence here reads as a bug report: rows the developer deleted yesterday are
    // on their screen this morning, and nothing said why.
    const harness = serviceHarness({ volumes: [DB_VOLUME] });
    const prepared = await prepareSupabaseService({
      origin: 'http://127.0.0.1:5173',
      callerVars: {},
      autoSignIn: true,
      progress: recordingProgress().progress,
      dependencies: harness.dependencies,
    });

    const summary = prepared.summary.join('\n');
    expect(summary).toContain('Restored the data');
    expect(summary).toContain('--fresh');
    // Not "fresh", and no discard: this is an ordinary boot.
    expect(harness.calls).not.toContain('discard');
  });

  test('a first boot on this machine claims nothing was restored', async () => {
    const harness = serviceHarness({ volumes: [] });
    const prepared = await prepareSupabaseService({
      origin: 'http://127.0.0.1:5173',
      callerVars: {},
      autoSignIn: true,
      progress: recordingProgress().progress,
      dependencies: harness.dependencies,
    });

    expect(prepared.summary.join('\n')).not.toContain('Restored the data');
  });

  test('the volume list is read before the start, and after the probe', async () => {
    // After the start the volume always exists — this very start created it — so
    // reading afterwards would report a restore on every single boot.
    const harness = serviceHarness({ volumes: [DB_VOLUME] });
    await prepareSupabaseService({
      origin: 'http://127.0.0.1:5173',
      callerVars: {},
      autoSignIn: true,
      progress: recordingProgress().progress,
      dependencies: harness.dependencies,
    });

    expect(harness.calls.indexOf('listVolumes')).toBeLessThan(harness.calls.indexOf('start'));
    // After the probe, so the fast path — adopting a running database — never pays
    // for a `docker volume ls` it would not use.
    expect(harness.calls.indexOf('listVolumes')).toBeGreaterThan(harness.calls.indexOf('probe'));
  });

  test('an adopted stack is not asked about volumes at all', async () => {
    const harness = serviceHarness({ running: true, volumes: [DB_VOLUME] });
    const prepared = await prepareSupabaseService({
      origin: 'http://127.0.0.1:5173',
      callerVars: {},
      autoSignIn: true,
      progress: recordingProgress().progress,
      dependencies: harness.dependencies,
    });

    expect(prepared.label).toContain('reused');
    expect(harness.calls).toEqual(['allocate', 'probe']);
  });
});

describe('a stack that failed to start keeps nothing', () => {
  test('the teardown after a failed seed does not preserve the volume', async () => {
    // Preserving here would leave a half-started stack's volume for the next run to
    // restore: a database nobody ever reached, announced as somebody's data.
    const harness = serviceHarness();
    const dependencies = {
      ...harness.dependencies,
      seed: (async () => {
        throw new Error('seed failed');
      }) as never,
      stop: (async (_a: unknown, _o: unknown, stopOptions?: { preserveData?: boolean }) => {
        harness.calls.push(`stop:${JSON.stringify(stopOptions ?? {})}`);
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

    expect(harness.calls).toContain('stop:{}');
  });
});

describe('--fresh is one flag with no value', () => {
  test('it is recognised among other arguments', () => {
    const parsed = parseFreshFlag(['app', '--fresh', '--stack', 'client']);
    expect(parsed.fresh).toBe(true);
    expect(parsed.rest).toEqual(['app', '--stack', 'client']);
  });

  test('it is absent when nobody asked for it', () => {
    expect(parseFreshFlag(['app']).fresh).toBe(false);
  });

  test('--fresh with a value is refused, and the refusal names the flag', () => {
    // Silently accepting `--fresh=true` would pass as `--fresh` on the day somebody
    // typed `--fresh=false` expecting to keep their data, and hand them a database
    // with the previous run's rows in it.
    const parsed = parseFreshFlag(['--fresh=true']);
    expect(parsed.fresh).toBe(false);
    expect(parsed.problem).toContain('--fresh=true takes no value');
  });
});

describe('missing ownership metadata is recovered using project labels', () => {
  test('db:stop removes labeled containers, keeps volumes, and refuses a second stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supabase-recovery-'));
    try {
      const project = devSupabaseAllocation(root).projectId;
      const engine = fakeEngine([DB_VOLUME], ['owned-container'], project);
      expect((await stopDevSupabaseLocal(root, { runtime: engine.runtime })).stopped).toBe(true);
      expect(engine.argv).toContainEqual(['rm', '-f', 'owned-container']);
      expect(engine.held()).toEqual([DB_VOLUME]);
      expect((await stopDevSupabaseLocal(root, { runtime: engine.runtime })).stopped).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('discard removes and verifies containers before touching volumes', () => {
    const engine = fakeEngine([DB_VOLUME], ['owned-container']);
    expect(discardSupabaseData(allocation(), { runtime: engine.runtime })).toEqual([DB_VOLUME]);
    expect(engine.argv.map((args) => args.slice(0, 2))).toEqual([
      ['ps', '-aq'],
      ['rm', '-f'],
      ['ps', '-aq'],
      ['volume', 'ls'],
      ['volume', 'rm'],
    ]);
    expect(engine.argv).toContainEqual(['rm', '-f', 'owned-container']);
  });

  test.each(['query', 'remove', 'verify'])('a failed %s prevents volume handling', (failure) => {
    const calls: string[][] = [];
    const runtime: SupabaseRuntime = {
      command: 'fake-engine',
      run: (args) => {
        calls.push([...args]);
        const fails =
          (failure === 'query' && calls.length === 1) || (failure === 'remove' && args[0] === 'rm');
        return {
          status: fails ? 1 : 0,
          stdout: args[0] === 'ps' ? 'owned-container' : '',
          stderr: 'fixture refusal',
        };
      },
    };
    expect(() => discardSupabaseData(allocation(), { runtime })).toThrow();
    expect(calls.some((args) => args[0] === 'volume')).toBe(false);
  });
});
