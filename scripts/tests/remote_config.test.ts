import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deployStep, migrationStep } from '../src/deploy/apply.ts';
import { secretPlan } from '../src/deploy/provision.ts';
import { renderRemoteConfig, writeRemoteConfig } from '../src/deploy/remote_config.ts';
import type { ResolvedTarget } from '../src/deploy/target.ts';

const roots: string[] = [];
const target = (enabled = false, containerImage = '../media/Dockerfile'): ResolvedTarget => ({
  deploymentProfile: 'legacy',
  environment: 'staging',
  project: 'starter',
  accountId: 'a'.repeat(32),
  workerName: 'exact-web-staging',
  d1DatabaseId: 'resolved-database',
  origin: 'https://exact-web-staging.example.workers.dev',
  mailFrom: 'no-reply@example.test',
  nativeApiOrigin: null,
  supabase: null,
  wranglerConfig: 'apps/frontend/client/wrangler.jsonc',
  jobsWranglerConfig: 'apps/backend/jobs/wrangler.jsonc',
  requiredSecretNames: ['BETTER_AUTH_SECRET', 'RESEND_API_KEY'],
  requiredVarNames: [],
  compute: {
    enabled,
    profile: enabled ? 'encode' : 'disabled',
    jobsWorkerName: enabled ? 'exact-jobs-staging' : null,
    mediaBucketName: enabled ? 'exact-bucket-staging' : null,
    encodeWorkflowName: enabled ? 'exact-encode-staging' : null,
    maintenanceWorkflowName: enabled ? 'exact-maintenance-staging' : null,
    containerImage: enabled ? containerImage : null,
    imageProtocol: enabled ? 'sample-v1' : null,
    containerProfile: enabled ? 'basic' : null,
  },
});
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'remote-config-'));
  roots.push(root);
  const web = join(root, target().wranglerConfig);
  const jobs = join(root, target().jobsWranglerConfig);
  mkdirSync(dirname(web), { recursive: true });
  mkdirSync(dirname(jobs), { recursive: true });
  writeFileSync(
    web,
    JSON.stringify({
      main: '.svelte-kit/cloudflare/_worker.js',
      assets: {
        binding: 'ASSETS',
        directory: '.svelte-kit/cloudflare',
        not_found_handling: 'none',
      },
      d1_databases: [{ binding: 'DB', database_id: 'wrong-database' }],
      env: {
        staging: {
          vars: { JOBS_PROFILE: 'encode' },
          r2_buckets: [{ binding: 'MEDIA', bucket_name: 'wrong-bucket' }],
          workflows: [{ script_name: 'wrong-worker' }],
        },
      },
    }),
  );
  writeFileSync(
    jobs,
    JSON.stringify({
      main: 'dist/index.js',
      workers_dev: true,
      triggers: { crons: ['17 * * * *'] },
      containers: [
        { image: '../media/Dockerfile', image_build_context: '../media', max_instances: 2 },
      ],
      workflows: [
        { binding: 'ENCODE_WORKFLOW', class_name: 'EncodeWorkflow', limits: { steps: 32 } },
        { binding: 'MAINTENANCE_WORKFLOW', class_name: 'MaintenanceWorkflow' },
      ],
    }),
  );
  // A local build input exists; a registry reference does not. The rendered
  // config decides between them by that, so the fixture has to have one.
  mkdirSync(join(root, 'apps/backend/media'), { recursive: true });
  writeFileSync(join(root, 'apps/backend/media/Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(root, 'apps/backend/media/processor.build'), 'FROM scratch\n');
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('web-only plans cannot publish template compute bindings or stale database IDs', () => {
  const root = fixture();
  const config = renderRemoteConfig({ target: target(), root });
  expect(config.name).toBe('exact-web-staging');
  expect(config.account_id).toBe('a'.repeat(32));
  expect(config.vars).toEqual({
    DEPLOYMENT_ENV: 'staging',
    JOBS_PROFILE: 'disabled',
    BETTER_AUTH_URL: target().origin,
    MAIL_FROM: target().mailFrom,
  });
  expect(config.r2_buckets).toBeUndefined();
  expect(config.workflows).toBeUndefined();
  expect(config.no_bundle).toBe(true);
  expect(config.env).toBeUndefined();
  expect(JSON.stringify(config)).not.toContain('wrong-database');
  expect(JSON.stringify(config)).toContain('resolved-database');
  expect(config.main).toBe(join(root, 'apps/frontend/client/.svelte-kit/cloudflare/_worker.js'));
  const migration = migrationStep(target(), root);
  expect(migration.ok).toBe(true);
  expect(existsSync(join(root, '.starter'))).toBe(false);
});

test('Supabase configs consume the discovered immutable runner subject on both Worker roles', () => {
  const root = fixture();
  const legacy = target(
    true,
    `europe-north1-docker.pkg.dev/starter-staging/media/runner@sha256:${'a'.repeat(64)}`,
  );
  const supabase: ResolvedTarget = {
    ...legacy,
    deploymentProfile: 'supabase',
    d1DatabaseId: '',
    requiredSecretNames: [
      'SUPABASE_SERVICE_ROLE_KEY',
      'RESEND_API_KEY',
      'GOOGLE_DISPATCHER_CREDENTIAL',
    ],
    supabase: {
      projectRef: 'stageprojectref00001',
      url: 'https://stageprojectref00001.supabase.co',
      authUrl: 'https://stageprojectref00001.supabase.co',
      publishableKey: 'sb_publishable_public',
      nativeRedirectAllowlist: [
        'https://exact-web-staging.example.workers.dev/auth/callback',
        'com.example.starter://auth/callback',
      ],
      googleProjectId: 'starter-staging',
      googleRegion: 'europe-north1',
      jobName: 'starter-media-staging',
      image:
        'https://europe-north1-docker.pkg.dev/starter-staging/media/runner@sha256:' +
        'a'.repeat(64),
      runnerServiceAccount: 'runner@starter-staging.iam.gserviceaccount.com',
      dispatcherServiceAccount: 'dispatch@starter-staging.iam.gserviceaccount.com',
      protocol: 'sample-v1',
      cpu: '2',
      memory: '2Gi',
      timeoutSeconds: 600,
    },
  };
  expect(() => renderRemoteConfig({ target: supabase, root })).toThrow('uniqueId');
  const web = renderRemoteConfig({ target: supabase, root, runnerSubject: '12345678901234567890' });
  const jobs = renderRemoteConfig({
    target: supabase,
    root,
    kind: 'jobs',
    runnerSubject: '12345678901234567890',
  });
  expect((web.vars as Record<string, unknown>).GOOGLE_RUNNER_SUBJECT).toBe('12345678901234567890');
  expect((jobs.vars as Record<string, unknown>).GOOGLE_RUNNER_SUBJECT).toBe('12345678901234567890');
  expect((web.vars as Record<string, unknown>).SUPABASE_ANON_KEY).toBe('sb_publishable_public');
  expect(jobs.containers).toBeUndefined();
  expect(jobs.durable_objects).toBeUndefined();
  expect(JSON.stringify({ web, jobs })).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
});

test('derived config generation never rewrites the committed template', () => {
  const root = fixture();
  const path = join(root, target().wranglerConfig);
  const before = readFileSync(path, 'utf8');
  const derived = writeRemoteConfig({ target: target(), root });
  expect(derived).toBe(join(root, '.starter/deploy/staging-web.json'));
  expect(readFileSync(path, 'utf8')).toBe(before);
});

test('secrets and deploys address the same exact Worker without an env suffix', () => {
  const deploy = deployStep(target(), 'a'.repeat(40), 'sha256:fixture');
  const secrets = secretPlan(target(), 'env');
  for (const args of [deploy.args, ...secrets.map((step) => step.argv)]) {
    expect(args).not.toContain('--env');
    expect(args[args.indexOf('--name') + 1]).toBe(target().workerName);
    expect(args[args.indexOf('--config') + 1]).toContain('staging-web.json');
  }
});

test('compute bindings, image, and private jobs identity come from the resolved target', () => {
  const root = fixture();
  const web = renderRemoteConfig({ target: target(true), root });
  expect(web.r2_buckets).toEqual([{ binding: 'MEDIA', bucket_name: 'exact-bucket-staging' }]);
  expect(web.workflows).toEqual([
    {
      binding: 'ENCODE_WORKFLOW',
      class_name: 'EncodeWorkflow',
      name: 'exact-encode-staging',
      script_name: 'exact-jobs-staging',
    },
  ]);
  const jobs = renderRemoteConfig({ target: target(true), root, kind: 'jobs' });
  expect(jobs.name).toBe('exact-jobs-staging');
  expect(jobs.r2_buckets).toEqual(web.r2_buckets);
  expect(jobs.d1_databases).toEqual(web.d1_databases);
  expect(jobs.workers_dev).toBe(false);
  expect(jobs.triggers).toEqual({ crons: ['17 * * * *'] });
  expect(JSON.stringify(jobs.containers)).toContain(join(root, 'apps/backend/media/Dockerfile'));
  expect(JSON.stringify(jobs.workflows)).toContain('exact-maintenance-staging');
  expect(JSON.stringify(jobs.workflows)).toContain('"steps":32');
});

test('a relative local image is resolved whatever it is named, and a reference is left alone', () => {
  // `Dockerfile` in the name was the whole test for "this is a local path". A
  // build input called `processor.build` was therefore emitted unresolved, and
  // wrangler read it relative to its own working directory.
  const root = fixture();
  const named = renderRemoteConfig({
    target: target(true, '../media/processor.build'),
    root,
    kind: 'jobs',
  });

  expect(JSON.stringify(named.containers)).toContain(
    join(root, 'apps/backend/media/processor.build'),
  );

  // A registry reference is not a path, and `existsSync` is what tells them apart:
  // `ghcr.io/starter/processor:sample-v1` cannot exist beside the source config.
  const reference = 'ghcr.io/starter/processor:sample-v1';
  const published = renderRemoteConfig({ target: target(true, reference), root, kind: 'jobs' });
  const containers = published.containers as { image: string }[];

  expect(containers[0]?.image).toBe(reference);
});

test('broken artifact policy fails before a derived config can be written', () => {
  const root = fixture();
  writeFileSync(join(root, target().wranglerConfig), '{"main": "missing-assets.js"}');
  expect(() => writeRemoteConfig({ target: target(), root })).toThrow();
  expect(existsSync(join(root, '.starter'))).toBe(false);
});
