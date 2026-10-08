import { expect, test } from 'bun:test';
import { buildWorkerGraph, parseWranglerJsonc } from './worker_graph.ts';

const config = (extra = '') =>
  parseWranglerJsonc(`{
  "name": "web",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "main": ".svelte-kit/cloudflare/_worker.js",
  "assets": { "binding": "ASSETS", "directory": ".svelte-kit/cloudflare", "not_found_handling": "none" },
  "vars": { "JOBS_PROFILE": "disabled" }${extra}
}`);

const graph = (client = config()) =>
  buildWorkerGraph({
    client,
    clientRoot: '/repo/apps/frontend/client',
    testRunId: 'visual_full_01',
    appOrigin: 'http://127.0.0.1:4183',
    supabaseUrl: 'http://127.0.0.1:54321',
    supabaseAnonKey: 'local-anon',
    supabaseServiceRoleKey: 'local-service-role',
    supabaseMailUrl: 'http://127.0.0.1:54324',
  });
const configJson = (profile: string) =>
  `{"name":"web","compatibility_date":"2026-10-01","main":"worker.js","assets":{"binding":"ASSETS","directory":"assets"},"vars":{"JOBS_PROFILE":"${profile}"}}`;

test('the built web Worker uses local Supabase and explicitly disables optional compute', () => {
  const result = graph();
  expect(result.workers).toHaveLength(1);
  const worker = result.workers[0];
  expect(worker?.bindings).toMatchObject({
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_ANON_KEY: 'local-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'local-service-role',
    DEPLOYMENT_ENV: 'local',
    JOBS_PROFILE: 'disabled',
    APP_ORIGIN: 'http://127.0.0.1:4183',
    TEST_RUN_ID: 'visual_full_01',
  });
  expect(worker?.d1Databases).toBeUndefined();
  expect(worker?.durableObjects).toBeUndefined();
  expect(worker?.assets).toMatchObject({ binding: 'ASSETS', run_worker_first: true });
});

test('a web Worker with a legacy D1 application binding is refused', () => {
  expect(() =>
    graph(config(', "d1_databases": [{"binding":"DB","database_name":"legacy"}]')),
  ).toThrow('must not declare an application D1 binding');
});

test('missing or enabled compute is refused in the web-only E2E fixture', () => {
  expect(() =>
    graph(
      parseWranglerJsonc(
        '{"name":"web","main":"worker.js","assets":{"binding":"ASSETS","directory":"assets"}}',
      ),
    ),
  ).toThrow('JOBS_PROFILE=disabled explicitly');
  expect(() => graph(parseWranglerJsonc(configJson('encode')))).toThrow(
    'JOBS_PROFILE=disabled explicitly',
  );
});
