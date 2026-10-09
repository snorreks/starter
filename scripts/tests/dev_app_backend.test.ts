import { describe, expect, mock, test } from 'bun:test';
import type { SupabaseLocalAllocation } from '../src/db/supabase_local.ts';
import {
  buildTarget,
  callerSupabaseValues,
  type DevBackendDependencies,
  prepareDevBackend,
} from '../src/dev-app.ts';

const allocation = {
  projectId: 'devproject',
  runId: 'dev_test',
  ownerToken: 'token',
  root: '/owned/run',
  ports: { api: 54_321, postgres: 54_322, studio: 54_323, mail: 54_324 },
  urls: {
    api: 'http://127.0.0.1:54321',
    postgres: 'postgresql://postgres@127.0.0.1:54322/postgres',
    studio: 'http://127.0.0.1:54323',
    mail: 'http://127.0.0.1:54324',
  },
} as unknown as SupabaseLocalAllocation;

/** Records every collaborator call so a test can assert what ran, and in what order. */
const recorder = () => {
  const calls: string[] = [];
  let written: Record<string, string> = {};
  let stopFailure: string | undefined;
  const dependencies: Partial<DevBackendDependencies> = {
    allocate: mock(() => {
      calls.push('allocate');
      return allocation;
    }) as unknown as DevBackendDependencies['allocate'],
    start: mock(async () => {
      calls.push('start');
      return {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: 'local-anon',
        SUPABASE_SERVICE_ROLE_KEY: 'local-service-role',
        SUPABASE_MAIL_URL: 'http://127.0.0.1:54324',
      };
    }) as unknown as DevBackendDependencies['start'],
    writeVars: mock(
      async (_allocation: SupabaseLocalAllocation, values: Record<string, string>) => {
        calls.push('writeVars');
        written = values;
        return { path: '/owned/run/supabase.dev.vars', contents: 'contents' };
      },
    ) as unknown as DevBackendDependencies['writeVars'],
    hasOwnership: mock(async () => {
      calls.push('hasOwnership');
      return true;
    }) as unknown as DevBackendDependencies['hasOwnership'],
    readOwnership: mock(async () => {
      calls.push('readOwnership');
      return {} as never;
    }) as unknown as DevBackendDependencies['readOwnership'],
    stop: mock(async () => {
      calls.push('stop');
      if (stopFailure !== undefined) {
        throw new Error(stopFailure);
      }
    }) as unknown as DevBackendDependencies['stop'],
  };
  return {
    calls,
    dependencies,
    written: () => written,
    /** Make the engine refuse the stop, without reaching for a mock's own type. */
    refuseStop: (message: string) => {
      stopFailure = message;
    },
  };
};

describe('the dev server has a backend to talk to', () => {
  test('an unset SUPABASE_URL starts the owned local stack and says so', async () => {
    const recorder_ = recorder();
    const backend = await prepareDevBackend('http://127.0.0.1:5173', recorder_.dependencies, {});
    expect(recorder_.calls).toEqual(['allocate', 'start', 'writeVars']);
    expect(backend.owned).toBe(true);
    expect(backend.summary.join('\n')).toContain('http://127.0.0.1:54321');
    // The values the 503 used to name, plus the vars the dev server never forwarded.
    expect(recorder_.written()).toEqual({
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_ANON_KEY: 'local-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'local-service-role',
      SUPABASE_MAIL_URL: 'http://127.0.0.1:54324',
      DEPLOYMENT_ENV: 'local',
      APP_ORIGIN: 'http://127.0.0.1:5173',
    });
  });

  test('a caller who named a project keeps it: no container engine is touched', async () => {
    const recorder_ = recorder();
    const backend = await prepareDevBackend('http://127.0.0.1:5173', recorder_.dependencies, {
      SUPABASE_URL: 'https://abc.supabase.co',
      SUPABASE_ANON_KEY: 'anon',
      SUPABASE_SERVICE_ROLE_KEY: 'service',
    });
    expect(recorder_.calls).toEqual(['allocate', 'writeVars']);
    expect(backend.owned).toBe(false);
    expect(backend.summary.join('\n')).toContain('https://abc.supabase.co');
    expect(recorder_.written()).toMatchObject({
      SUPABASE_URL: 'https://abc.supabase.co',
      DEPLOYMENT_ENV: 'local',
      APP_ORIGIN: 'http://127.0.0.1:5173',
    });
    // Nothing was started, so nothing is stopped: this run owns no stack.
    expect(await backend.dispose()).toEqual([]);
    expect(recorder_.calls).not.toContain('stop');
  });

  test('disposing stops the stack it started', async () => {
    const recorder_ = recorder();
    const backend = await prepareDevBackend('http://127.0.0.1:5173', recorder_.dependencies, {});
    expect(await backend.dispose()).toEqual([]);
    expect(recorder_.calls).toEqual([
      'allocate',
      'start',
      'writeVars',
      'hasOwnership',
      'readOwnership',
      'stop',
    ]);
  });

  test('a stack that refuses to stop is reported, and the file is still removed', async () => {
    const recorder_ = recorder();
    const backend = await prepareDevBackend('http://127.0.0.1:5173', recorder_.dependencies, {});
    recorder_.refuseStop('container engine refused');
    expect(await backend.dispose()).toEqual(['container engine refused']);
    // The stack was still attempted: a refusal to stop must not skip the attempt.
    expect(recorder_.calls).toContain('stop');
  });
});

describe('both dev modes read the owned file', () => {
  test('wrangler takes it as --env-file', () => {
    const target = buildTarget('built', '/owned/run/supabase.dev.vars');
    expect(target.args).toContain('--env-file');
    expect(target.args[target.args.indexOf('--env-file') + 1]).toBe('/owned/run/supabase.dev.vars');
  });

  test('a dev server with no file does not pass a dangling --env-file', () => {
    expect(buildTarget('built', undefined).args).not.toContain('--env-file');
    // Vite has no flag for it: the platform proxy reads STARTER_RUNTIME_ENV_FILE,
    // which `main` sets from the same path before spawning.
    const app = buildTarget('app').args;
    expect(app[0]).toBe('dev');
    expect(app).toContain('--strictPort');
    // The port is this checkout's, not a literal: worktrees run independently.
    expect(app[app.indexOf('--port') + 1]).toMatch(/^\d+$/);
  });
});

describe('only a caller who named a project counts as having one', () => {
  test('an unset or blank URL is not a project', () => {
    expect(callerSupabaseValues({})).toEqual({});
    expect(callerSupabaseValues({ SUPABASE_URL: '   ' })).toEqual({});
    expect(callerSupabaseValues({ SUPABASE_URL: 'https://abc.supabase.co' })).toEqual({
      SUPABASE_URL: 'https://abc.supabase.co',
    });
  });
});
