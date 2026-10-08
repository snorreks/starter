import { expect, test } from 'bun:test';
import { e2eProcessOptions } from './run_e2e.ts';

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
