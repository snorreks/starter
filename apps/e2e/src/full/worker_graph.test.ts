import { expect, test } from 'bun:test';
import { buildWorkerGraph, parseWranglerJsonc } from './worker_graph.ts';

const clientConfig = `{
  // A JSONC configuration is the source of runtime facts.
  "name": "web",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "main": ".svelte-kit/cloudflare/_worker.js",
  "assets": { "binding": "ASSETS", "directory": ".svelte-kit/cloudflare", "not_found_handling": "none" },
  "d1_databases": [{ "binding": "DB", "database_name": "shared-db" }]
}`;
const jobsConfig = `{
  "name": "jobs",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "main": "dist/index.js",
  "d1_databases": [{ "binding": "DB", "database_name": "shared-db", "migrations_dir": "migrations" }],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "shared-media" }],
  "durable_objects": { "bindings": [{ "name": "CONTAINER", "class_name": "EncodeContainer" }] },
  "workflows": [{ "binding": "ENCODE_WORKFLOW", "name": "starter-encode", "class_name": "EncodeWorkflow" }]
}`;

test('the full graph shares declared stores and dispatches the declared Workflow cross-Worker', () => {
  const graph = buildWorkerGraph({
    client: parseWranglerJsonc(clientConfig),
    jobs: parseWranglerJsonc(jobsConfig),
    clientRoot: '/repo/apps/frontend/client',
    jobsRoot: '/repo/apps/backend/jobs',
    testRunId: 'visual_full_01',
    processorOrigin: 'http://127.0.0.1:8099',
    authSecret: 'a sufficiently long local only test secret',
    trustedOrigins: 'http://127.0.0.1:4183',
  });
  expect(graph.workers).toHaveLength(2);
  expect((graph.workers[0]?.d1Databases as Record<string, unknown>)?.DB).toBe('shared-db');
  expect((graph.workers[1]?.d1Databases as Record<string, unknown>)?.DB).toBe('shared-db');
  expect((graph.workers[0]?.r2Buckets as Record<string, unknown>)?.MEDIA).toBe('shared-media');
  expect((graph.workers[1]?.r2Buckets as Record<string, unknown>)?.MEDIA).toBe('shared-media');
  expect(graph.workers[0]?.workflows?.ENCODE_WORKFLOW).toEqual({
    name: 'starter-encode',
    className: 'EncodeWorkflow',
    scriptName: 'jobs',
  });
  expect(graph.workers[0]?.assets?.run_worker_first).toBe(true);
});

test('a divergent D1 database fails before a server can start', () => {
  const jobs = parseWranglerJsonc(jobsConfig);
  const databases = jobs.d1_databases as Array<Record<string, unknown>>;
  const database = databases[0];
  if (database === undefined) {
    throw new Error('Fixture config omitted its D1 database.');
  }
  database.database_name = 'private-jobs-db';
  expect(() =>
    buildWorkerGraph({
      client: parseWranglerJsonc(clientConfig),
      jobs,
      clientRoot: '/repo/apps/frontend/client',
      jobsRoot: '/repo/apps/backend/jobs',
      testRunId: 'visual_full_01',
      processorOrigin: 'http://127.0.0.1:8099',
      authSecret: 'a sufficiently long local only test secret',
      trustedOrigins: 'http://127.0.0.1:4183',
    }),
  ).toThrow('must share the same D1');
});
