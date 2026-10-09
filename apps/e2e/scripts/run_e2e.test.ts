import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateSupabaseLocal } from '../../../scripts/src/db/supabase_local.ts';
import { readRuntimeBindings } from '../src/full/runtime_bindings.ts';
import { e2eProcessOptions, runE2E } from './run_e2e.ts';

const options = () =>
  e2eProcessOptions({
    environment: {
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_ANON_KEY: 'public-fixture',
      SUPABASE_SERVICE_ROLE_KEY: 'private-fixture',
      CLOUDFLARE_API_TOKEN: 'deploy-fixture',
      STARTER_DEV_VARS_PATH: '/stale/vars',
      E2E_RUN_ID: 'stale-run',
    },
    varsPath: '/owned/worker-vars',
    runId: 'owned-run',
    args: ['--grep', 'recovery'],
  });

test('browser subprocess cannot inherit application or deployment secrets', () => {
  const environment = options().env;
  expect(environment?.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  expect(environment?.CLOUDFLARE_API_TOKEN).toBeUndefined();
  expect(environment?.SUPABASE_URL).toBe('http://127.0.0.1:54321');
  expect(environment?.SUPABASE_ANON_KEY).toBe('public-fixture');
});

test('owned identity and private vars path replace stale caller values', () => {
  const environment = options().env;
  expect(environment?.STARTER_DEV_VARS_PATH).toBe('/owned/worker-vars');
  expect(environment?.E2E_RUN_ID).toBe('owned-run');
});

test('browser execution bounds bytes and time and preserves forwarded assertions', () => {
  const process = options();
  expect(process.timeoutMs).toBe(20 * 60_000);
  expect(process.maxBytes).toBe(16 * 1024 * 1024);
  expect(process.args).toEqual(['run', 'test:e2e:playwright', '--', '--grep', 'recovery']);
  expect(process.cwd.endsWith('/apps/e2e/')).toBe(true);
  expect(process.stdio).not.toBe('inherit');
});

const bindings = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'public-fixture',
  SUPABASE_SERVICE_ROLE_KEY: 'private-fixture',
};

test('full E2E provisions before Playwright and supplies runtime bindings through the private file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'full-e2e-'));
  const allocation = { ...allocateSupabaseLocal(root, 'full-fixture'), root };
  const calls: string[] = [];
  try {
    const code = await runE2E(['--full', '--grep', 'fixture'], {
      allocateSupabaseLocal: () => allocation,
      startSupabaseLocal: async (_allocation, options) => {
        expect(options).toEqual({ emailConfirmations: true });
        calls.push('provision');
        return bindings;
      },
      runBounded: async (options) => {
        calls.push('playwright');
        expect(options.args).toEqual(['run', 'test:full:playwright', '--', '--grep', 'fixture']);
        expect(options.env?.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
        expect(readRuntimeBindings(options.env ?? {})).toEqual(bindings);
        expect(options.env?.E2E_RUN_ID).toBe(allocation.runId);
        return { code: 0, stdout: '', stderr: '' };
      },
      hasSupabaseOwnership: async () => true,
      readSupabaseOwnership: async () => allocation,
      stopSupabaseLocal: async () => {
        calls.push('stop');
      },
    });
    expect(code).toBe(0);
    expect(calls).toEqual(['provision', 'playwright', 'stop']);
    expect(() =>
      readRuntimeBindings({ STARTER_DEV_VARS_PATH: join(root, 'supabase.dev.vars') }),
    ).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([0, 7, 'throw'] as const)(
  'cleanup attempts both steps and preserves browser result %s',
  async (result) => {
    const allocation = allocateSupabaseLocal('/tmp/e2e-cleanup-fixture', 'cleanup');
    const calls: string[] = [];
    const first = new Error('vars cleanup failed');
    const reported: unknown[] = [];
    const run = runE2E([], {
      allocateSupabaseLocal: () => allocation,
      startSupabaseLocal: async () => bindings,
      writeOwnedWorkerVars: async () => ({ path: '/fixture/vars', contents: '' }),
      runBounded: async () => {
        if (result === 'throw') {
          throw new Error('browser failed');
        }
        return { code: result, stdout: '', stderr: '' };
      },
      removeOwnedWorkerVars: async () => {
        calls.push('vars');
        throw first;
      },
      hasSupabaseOwnership: async () => true,
      readSupabaseOwnership: async () => allocation,
      stopSupabaseLocal: async () => {
        calls.push('stop');
        throw new Error('stop failed');
      },
      reportTeardownFailure: (error) => {
        calls.push('report');
        reported.push(error);
      },
    });
    if (result === 'throw') {
      await expect(run).rejects.toThrow('browser failed');
    } else {
      expect(await run).toBe(result === 0 ? 1 : result);
    }
    expect(calls).toEqual(['vars', 'stop', 'report']);
    expect(reported).toEqual([first]);
  },
);

test('full runtime refuses missing required bindings', async () => {
  expect(() => readRuntimeBindings({ SUPABASE_URL: bindings.SUPABASE_URL })).toThrow(
    'SUPABASE_ANON_KEY',
  );
});
