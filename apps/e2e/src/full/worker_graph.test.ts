import { expect, test } from 'bun:test';
import { Response as MiniflareResponse } from 'miniflare';
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

test('full compute shares real R2 and cross-Worker Workflows, never a processor service replacement', () => {
  const outbound = async () => new MiniflareResponse(null, { status: 500 });
  const result = buildWorkerGraph({
    client: config(),
    clientRoot: '/repo/apps/frontend/client',
    testRunId: 'full_compute',
    stripe: { apiBase: 'https://stripe.test', secretKey: 'fixture', webhookSecret: 'fixture' },
    appOrigin: 'http://127.0.0.1:4183',
    supabaseUrl: 'http://127.0.0.1:54321',
    supabaseAnonKey: 'local-anon',
    supabaseServiceRoleKey: 'local-service-role',
    compute: {
      jobsRoot: '/repo/apps/backend/jobs',
      bindings: { COMPUTE_PROTOCOL: 'sample-v1' },
      outbound,
    },
  });
  expect(result.workers).toHaveLength(2);
  const [web, jobs] = result.workers;
  expect(jobs?.scriptPath).toBe('/repo/apps/backend/jobs/dist/index.js');
  for (const worker of result.workers) {
    expect(worker.bindings?.JOBS_PROFILE).toBe('encode');
    expect(worker.r2Buckets).toEqual({ MEDIA: 'e2e-media-full_compute' });
    expect(worker.outboundService).toBe(outbound);
    expect(worker.serviceBindings).toBeUndefined();
    expect(worker.workflows?.ENCODE_WORKFLOW).toMatchObject({
      className: 'EncodeWorkflow',
      scriptName: 'web-jobs',
    });
  }
  expect(web?.workflows).toEqual(jobs?.workflows);
  expect(web?.bindings?.STRIPE_SECRET_KEY).toBe('fixture');
  expect(jobs?.bindings?.STRIPE_SECRET_KEY).toBeUndefined();
  expect(jobs?.bindings?.STRIPE_WEBHOOK_SECRET).toBeUndefined();
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
        '{"name":"web","compatibility_date":"2026-10-01","main":"worker.js","assets":{"binding":"ASSETS","directory":"assets"}}',
      ),
    ),
  ).toThrow('JOBS_PROFILE=disabled explicitly');
  expect(() => graph(parseWranglerJsonc(configJson('encode')))).toThrow(
    'JOBS_PROFILE=disabled explicitly',
  );
});

test('Stripe bindings require all fields and also work without compute', () => {
  const options = {
    client: config(),
    clientRoot: '/repo/apps/frontend/client',
    testRunId: 'stripe',
    appOrigin: 'http://127.0.0.1:4183',
    supabaseUrl: 'http://127.0.0.1:54321',
    supabaseAnonKey: 'anon',
    supabaseServiceRoleKey: 'role',
  };
  expect(() =>
    buildWorkerGraph({
      ...options,
      stripe: { apiBase: '', secretKey: ' ', webhookSecret: undefined } as never,
    }),
  ).toThrow('apiBase, secretKey, webhookSecret');
  const result = buildWorkerGraph({
    ...options,
    stripe: { apiBase: 'https://stripe.test', secretKey: 'fixture', webhookSecret: 'fixture' },
  });
  expect(result.workers[0]?.bindings).toMatchObject({
    STRIPE_API_BASE: 'https://stripe.test',
    STRIPE_SECRET_KEY: 'fixture',
    STRIPE_WEBHOOK_SECRET: 'fixture',
  });
});
