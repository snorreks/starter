import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderRemoteConfig, writeRemoteConfig } from '../src/deploy/remote_config.ts';
import { testTarget } from './fixtures/deployment_target.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'remote-config-supabase-'));
  roots.push(root);
  for (const [relative, config] of [
    [
      'apps/frontend/client/wrangler.jsonc',
      {
        name: 'template-web',
        main: '.svelte-kit/cloudflare/_worker.js',
        assets: { binding: 'ASSETS', directory: '.svelte-kit/cloudflare' },
        vars: { DEPLOYMENT_ENV: 'local' },
        d1_databases: [{ binding: 'DB', database_id: 'must-be-removed' }],
      },
    ],
    [
      'apps/backend/jobs/wrangler.jsonc',
      {
        name: 'template-jobs',
        main: 'src/index.ts',
        workflows: [
          { binding: 'ENCODE_WORKFLOW', class_name: 'EncodeWorkflow', name: 'old-encode' },
          {
            binding: 'MAINTENANCE_WORKFLOW',
            class_name: 'MaintenanceWorkflow',
            name: 'old-maintenance',
          },
        ],
        r2_buckets: [{ binding: 'MEDIA', bucket_name: 'old-bucket' }],
        containers: [{ class_name: 'EncodeContainer' }],
        durable_objects: { bindings: [{ name: 'CONTAINER', class_name: 'EncodeContainer' }] },
      },
    ],
  ] as const) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config));
  }
  return root;
};

test('disabled compute yields a Supabase web config without legacy database or compute bindings', () => {
  const root = fixture();
  const config = renderRemoteConfig({ root, target: testTarget() });
  expect(config.d1_databases).toBeUndefined();
  expect(config.vars).toMatchObject({
    DEPLOYMENT_ENV: 'staging',
    JOBS_PROFILE: 'disabled',
    APP_ORIGIN: 'https://starter-staging.example.workers.dev',
    SUPABASE_URL: 'https://stageprojectref00001.supabase.co',
  });
  expect(config.workflows).toBeUndefined();
  expect(config.r2_buckets).toBeUndefined();
});

test('enabled compute renders Cloud Run configuration and has no Cloudflare container binding', () => {
  const root = fixture();
  const base = testTarget();
  const target = testTarget({
    requiredSecretNames: [
      'SUPABASE_SERVICE_ROLE_KEY',
      'RESEND_API_KEY',
      'GOOGLE_DISPATCHER_CREDENTIAL',
    ],
    compute: {
      enabled: true,
      profile: 'encode',
      jobsWorkerName: 'starter-jobs-staging',
      mediaBucketName: 'starter-media-staging',
      encodeWorkflowName: 'starter-encode-staging',
      maintenanceWorkflowName: 'starter-maintenance-staging',
      containerImage: base.supabase.image,
      imageProtocol: 'sample-v1',
      containerProfile: null,
    },
  });
  const config = renderRemoteConfig({
    root,
    target,
    kind: 'jobs',
    runnerSubject: '12345678901234567890',
  });
  expect(config.name).toBe('starter-jobs-staging');
  expect(config.workflows).toEqual([
    { binding: 'ENCODE_WORKFLOW', class_name: 'EncodeWorkflow', name: 'starter-encode-staging' },
    {
      binding: 'MAINTENANCE_WORKFLOW',
      class_name: 'MaintenanceWorkflow',
      name: 'starter-maintenance-staging',
    },
  ]);
  expect(config.triggers).toEqual({ crons: ['17 * * * *'] });
  expect(config.r2_buckets).toEqual([{ binding: 'MEDIA', bucket_name: 'starter-media-staging' }]);
  expect(config.containers).toBeUndefined();
  expect(config.durable_objects).toBeUndefined();
  expect(config.vars).toMatchObject({
    SUPABASE_URL: target.supabase.url,
    GOOGLE_CLOUD_RUN_JOB: target.supabase.jobName,
  });
});

test('disabled compute needs no Google identity to render a web config', () => {
  const root = fixture();
  expect(() => renderRemoteConfig({ root, target: testTarget() })).not.toThrow();
});

test('enabled compute refuses a web config without the runner identity, not only the jobs config', () => {
  const base = testTarget();
  const target = testTarget({
    compute: {
      enabled: true,
      profile: 'encode',
      jobsWorkerName: 'starter-jobs-staging',
      mediaBucketName: 'starter-media-staging',
      encodeWorkflowName: 'starter-encode-staging',
      maintenanceWorkflowName: 'starter-maintenance-staging',
      containerImage: base.supabase.image,
      imageProtocol: 'sample-v1',
      containerProfile: null,
    },
  });
  // The web Worker mints the grants the runner calls, so it needs the same
  // identity. A web config that renders without it fails later, at request time.
  expect(() => renderRemoteConfig({ root: fixture(), target, kind: 'web' })).toThrow(
    'runner service-account uniqueId',
  );
  expect(() =>
    renderRemoteConfig({ root: fixture(), target, kind: 'web', runnerSubject: 'not-a-subject' }),
  ).toThrow('runner service-account uniqueId');
  expect(() =>
    renderRemoteConfig({
      root: fixture(),
      target,
      kind: 'web',
      runnerSubject: '12345678901234567890',
    }),
  ).not.toThrow();
});

test('the generated config is exactly the reviewed render and is nonsecret', () => {
  const root = fixture();
  const target = testTarget();
  const path = writeRemoteConfig({ root, target });
  expect(existsSync(path)).toBe(true);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(renderRemoteConfig({ root, target }));
  expect(readFileSync(path, 'utf8')).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
});
