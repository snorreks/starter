import { describe, expect, mock, test } from 'bun:test';
import type { SupabaseLocalAllocation } from '../src/db/supabase_local.ts';
import {
  applyBackendVarsPath,
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
  const readVarsMock = mock((): Record<string, string> => {
    calls.push('readVars');
    return {};
  });
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
    readVars: readVarsMock as unknown as DevBackendDependencies['readVars'],
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
    /** Pretend an existing owned file already carries these bindings. */
    withExistingFile: (values: Record<string, string>) => {
      readVarsMock.mockImplementation(() => {
        calls.push('readVars');
        return values;
      });
    },
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
    expect(recorder_.calls).toEqual([]);
    expect(backend.owned).toBe(false);
    expect(backend.summary.join('\n')).toContain('https://abc.supabase.co');
    // The caller's bindings are already complete, so this run writes nothing and
    // owns nothing to tear down.
    expect(recorder_.calls).not.toContain('writeVars');
    expect(backend.varsPath).toBeUndefined();
    expect(await backend.dispose()).toEqual([]);
    expect(recorder_.calls).not.toContain('stop');
  });

  // The E2E lane's shape: URL and anon key in the environment, service-role key in
  // the owned file. Deciding on the environment alone calls this configuration
  // incomplete, and overwriting the file drops the credential it depends on.
  test('a backend split across the environment and the caller own file is left alone', async () => {
    const recorder_ = recorder();
    recorder_.withExistingFile({ SUPABASE_SERVICE_ROLE_KEY: 'file-service-role' });
    const backend = await prepareDevBackend('http://127.0.0.1:5173', recorder_.dependencies, {
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_ANON_KEY: 'local-anon',
      STARTER_DEV_VARS_PATH: '/caller/owned.vars',
    });
    expect(recorder_.calls).toEqual(['readVars']);
    expect(backend.owned).toBe(false);
    expect(backend.varsPath).toBe('/caller/owned.vars');
    expect(recorder_.calls).not.toContain('writeVars');
    expect(await backend.dispose()).toEqual([]);
  });

  test('a named project missing a key is refused, not served from a local stack', async () => {
    const recorder_ = recorder();
    await expect(
      prepareDevBackend('http://127.0.0.1:5173', recorder_.dependencies, {
        SUPABASE_URL: 'https://abc.supabase.co',
      }),
    ).rejects.toThrow('SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY');
    // Starting a stack here would serve a different database than the one named.
    expect(recorder_.calls).toEqual([]);
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

describe('the child reads the file in both modes dialects', () => {
  test('an owned file is pointed at wrangler and the Vite platform proxy', () => {
    const environment: NodeJS.ProcessEnv = {};
    applyBackendVarsPath('/owned/run/supabase.dev.vars', environment);
    expect(environment.STARTER_DEV_VARS_PATH).toBe('/owned/run/supabase.dev.vars');
    expect(environment.STARTER_RUNTIME_ENV_FILE).toBe('/owned/run/supabase.dev.vars');
  });

  // The E2E lane's service-role key lives in the file it owns. Pointing the child
  // at a different file is what broke that lane before this guard existed.
  test('a caller own file is not replaced by one this run did not write', () => {
    const environment: NodeJS.ProcessEnv = {
      STARTER_DEV_VARS_PATH: '/caller/owned.vars',
      STARTER_RUNTIME_ENV_FILE: '/caller/owned.vars',
    };
    applyBackendVarsPath(undefined, environment);
    expect(environment.STARTER_DEV_VARS_PATH).toBe('/caller/owned.vars');
    expect(environment.STARTER_RUNTIME_ENV_FILE).toBe('/caller/owned.vars');
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
