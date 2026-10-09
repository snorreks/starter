import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apply } from '../src/deploy/apply.ts';
import { preflightSupabaseProviders } from '../src/deploy/preflight.ts';
import { renderRemoteConfig } from '../src/deploy/remote_config.ts';
import type { ResolvedTarget } from '../src/deploy/target.ts';

const target: ResolvedTarget = {
  environment: 'staging',
  project: 'starter',
  accountId: 'a'.repeat(32),
  workerName: 'web-staging',
  origin: 'https://staging.example',
  wranglerConfig: 'apps/frontend/client/wrangler.jsonc',
  jobsWranglerConfig: 'apps/backend/jobs/wrangler.jsonc',
  compute: {
    enabled: false,
    profile: 'disabled',
    jobsWorkerName: null,
    mediaBucketName: null,
    encodeWorkflowName: null,
    maintenanceWorkflowName: null,
    containerImage: null,
    imageProtocol: null,
    containerProfile: null,
  },
  mailFrom: 'sender@example.test',
  nativeApiOrigin: 'https://staging.example',
  supabase: {
    projectRef: 'stageprojectref00001',
    url: 'https://stageprojectref00001.supabase.co',
    authUrl: 'https://stageprojectref00001.supabase.co',
    publishableKey: 'sb_publishable_public',
    nativeRedirectAllowlist: ['https://staging.example/auth/callback'],
    googleProjectId: '',
    googleRegion: '',
    jobName: '',
    image: '',
    runnerServiceAccount: '',
    dispatcherServiceAccount: '',
    protocol: '',
    cpu: '',
    memory: '',
    timeoutSeconds: 0,
  },
  requiredSecretNames: ['SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY'],
  requiredVarNames: [],
};

const roots: string[] = [];
const originalGoogleToken = process.env.GOOGLE_ACCESS_TOKEN;
const originalSupabaseToken = process.env.SUPABASE_ACCESS_TOKEN;
afterEach(() => {
  if (originalGoogleToken === undefined) {
    delete process.env.GOOGLE_ACCESS_TOKEN;
  } else {
    process.env.GOOGLE_ACCESS_TOKEN = originalGoogleToken;
  }
  if (originalSupabaseToken === undefined) {
    delete process.env.SUPABASE_ACCESS_TOKEN;
  } else {
    process.env.SUPABASE_ACCESS_TOKEN = originalSupabaseToken;
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-disabled-compute-'));
  roots.push(root);
  const path = join(root, target.wranglerConfig);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      main: '.svelte-kit/cloudflare/_worker.js',
      assets: { binding: 'ASSETS', directory: '.svelte-kit/cloudflare' },
    }),
  );
  return root;
};

describe('disabled compute remains optional through deployment consumers', () => {
  test('web configuration needs no runner identity or Google variables', () => {
    const config = renderRemoteConfig({ target, root: fixture() });
    expect(config.vars).toMatchObject({
      DEPLOYMENT_ENV: 'staging',
      APP_ORIGIN: 'https://staging.example',
      JOBS_PROFILE: 'disabled',
    });
    // The legacy D1 profile was removed with the legacy backend; it must not return.
    expect(config.vars).not.toHaveProperty('STARTER_BACKEND_PROFILE');
    expect(JSON.stringify(config.vars)).not.toContain('GOOGLE_');
    expect(config.workflows).toBeUndefined();
    expect(config.r2_buckets).toBeUndefined();
  });

  test('provider preflight reports disabled Google discovery without weakening Supabase credentials', async () => {
    const report = await preflightSupabaseProviders(target, { env: {} });
    expect(report.ok).toBe(false);
    expect(report.findings.find((finding) => finding.check === 'supabase')?.ok).toBe(false);
    const google = report.findings.find((finding) => finding.check === 'google');
    expect(google?.ok).toBe(true);
    expect(google?.detail).toContain('disabled');
    expect(google?.detail).toContain('NOT RUN');
    expect(JSON.stringify(report.commands)).not.toContain('Google');
  });

  test('callback configuration still runs while every Google mutation is unreachable', async () => {
    delete process.env.GOOGLE_ACCESS_TOKEN;
    process.env.SUPABASE_ACCESS_TOKEN = 'fixture-supabase-token';
    const calls: string[] = [];
    const result = await apply({
      target,
      root: fixture(),
      consented: true,
      only: ['jobs'],
      inspect: () => ({ ok: true, digest: 'sha256:fixture', fileCount: 1, problems: [] }),
      configureSupabaseAuth: async () => {
        calls.push('supabase-auth');
      },
      configureGoogleJob: async () => {
        throw new Error('Google Job must not run');
      },
      configureGoogleGrant: async () => {
        throw new Error('Google IAM must not run');
      },
      verifyGoogleImage: async () => {
        throw new Error('Google image must not run');
      },
      run: () => {
        throw new Error('No Worker is selected for publication');
      },
      capture: () => ({ ok: true, stdout: '[]', stderr: '' }),
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['supabase-auth']);
    expect(result.components.map((component) => component.identity)).toEqual([
      'stageprojectref00001:auth-callbacks',
    ]);
  });

  test('enabled compute still refuses a missing Google credential before publishing', async () => {
    delete process.env.GOOGLE_ACCESS_TOKEN;
    const enabled: ResolvedTarget = {
      ...target,
      compute: { ...target.compute, enabled: true, profile: 'encode' },
    };
    const result = await apply({ target: enabled, root: fixture(), consented: true });
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]?.detail).toContain('GOOGLE_ACCESS_TOKEN');
    expect(result.components).toEqual([]);
  });
});
