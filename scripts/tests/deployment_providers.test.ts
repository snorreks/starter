import { describe, expect, test } from 'bun:test';
import {
  applyDispatcherGrant,
  applyGoogleJob,
  getGoogleRunnerSubject,
  provisionGoogleTarget,
  enableGoogleApis,
  googleResourcePlan,
  inspectGoogleResources,
  verifyGoogleArtifactImage,
} from '../src/deploy/providers/google.ts';
import {
  inspectSupabaseAuthConfig,
  applySupabaseAuthConfig,
  runSupabaseMigration,
  supabaseMigrationArgs,
} from '../src/deploy/providers/supabase.ts';
import type { ResolvedTarget } from '../src/deploy/target.ts';

const target: ResolvedTarget = {
  deploymentProfile: 'supabase',
  environment: 'staging',
  project: 'starter',
  accountId: 'a'.repeat(32),
  workerName: 'web-staging',
  d1DatabaseId: '',
  origin: 'https://staging.example',
  wranglerConfig: 'apps/frontend/client/wrangler.jsonc',
  jobsWranglerConfig: 'apps/backend/jobs/wrangler.jsonc',
  compute: {
    enabled: true,
    profile: 'encode',
    jobsWorkerName: 'jobs-staging',
    mediaBucketName: 'r2-staging',
    encodeWorkflowName: 'EncodeWorkflow',
    maintenanceWorkflowName: 'MaintenanceWorkflow',
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
    nativeRedirectAllowlist: ['com.example.starter://auth/callback'],
    googleProjectId: 'starter-stage',
    googleRegion: 'europe-north1',
    jobName: 'starter-encode',
    image: `europe-north1-docker.pkg.dev/starter-stage/media/runner@sha256:${'a'.repeat(64)}`,
    runnerServiceAccount: 'runner@starter-stage.iam.gserviceaccount.com',
    dispatcherServiceAccount: 'dispatch@starter-stage.iam.gserviceaccount.com',
    protocol: 'sample-v1',
    cpu: '2',
    memory: '4Gi',
    timeoutSeconds: 600,
  },
  requiredSecretNames: [
    'SUPABASE_SERVICE_ROLE_KEY',
    'RESEND_API_KEY',
    'GOOGLE_DISPATCHER_CREDENTIAL',
  ],
  requiredVarNames: [],
};
const response = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status });

describe('provider boundaries use the resolved target and fail closed', () => {
  test('migration args pin exact project identity for every operation', () => {
    expect(supabaseMigrationArgs(target, 'push')).toContain('stageprojectref00001');
    expect(supabaseMigrationArgs(target, 'list')).toContain('stageprojectref00001');
  });

  test('migration runner receives exact project argv and token only in its environment', () => {
    let observed: { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;
    const result = runSupabaseMigration(target, 'push', {
      binary: 'pinned-supabase',
      env: { SUPABASE_ACCESS_TOKEN: 'secret-token' },
      run: (options) => {
        observed = { command: options.command, args: options.args, env: options.env };
        return { code: 0, stdout: 'pushed', stderr: '' };
      },
    });
    expect(result.code).toBe(0);
    expect(observed?.command).toBe('pinned-supabase');
    expect(observed?.args).toContain('stageprojectref00001');
    expect(observed?.args).not.toContain('secret-token');
    expect(observed?.env?.SUPABASE_ACCESS_TOKEN).toBe('secret-token');
  });

  test('Supabase callback inspection is read-only and apply sends only the resolved allowlist', async () => {
    const calls: Request[] = [];
    const fetcher = async (_url: string, init: RequestInit) => {
      calls.push(new Request(_url, init));
      return response({ site_url: target.origin });
    };
    await inspectSupabaseAuthConfig({ target, accessToken: 'token', fetcher });
    await applySupabaseAuthConfig({ target, accessToken: 'token', fetcher });
    expect(calls[0].method).toBe('GET');
    expect(calls[1].method).toBe('PATCH');
    expect(await calls[1].json()).toEqual({
      site_url: target.origin,
      uri_allow_list: 'com.example.starter://auth/callback',
    });
  });

  test('Google plan is private and derives only capability-required APIs', () => {
    const plan = googleResourcePlan(target);
    expect(plan.publicAccess).toBe(false);
    expect(plan.requiredApis).toContain('run.googleapis.com');
    expect(plan.requiredApis).not.toContain('compute.googleapis.com');
  });

  test('denied API discovery refuses before any mutation', async () => {
    const calls: string[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      if (String(url).includes('serviceusage')) {
        return response({ error: 'denied' }, 403);
      }
      return response({});
    };
    await expect(enableGoogleApis({ target, accessToken: 'token', fetcher })).rejects.toThrow(
      '403',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toStartWith('GET ');
  });

  test('Google preflight treats denied identity listing as an error', async () => {
    const fetcher = async (url: string | URL | Request) => {
      if (String(url).includes('serviceusage')) {
        return response({ services: [] });
      }
      if (String(url).includes('serviceAccounts')) {
        return response({ error: 'denied' }, 403);
      }
      return response({});
    };
    await expect(inspectGoogleResources({ target, accessToken: 'token', fetcher })).rejects.toThrow(
      '403',
    );
  });

  test('Google provisioning records only completed API enables and stops on denied identity discovery', async () => {
    const calls: { url: string; method: string }[] = [];
    const plan = googleResourcePlan(target);
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url);
      calls.push({ url: address, method: init?.method ?? 'GET' });
      if (address.includes('serviceusage') && address.includes('filter=state:ENABLED')) {
        return response({
          services: plan.requiredApis
            .filter((api) => api !== 'artifactregistry.googleapis.com')
            .map((name) => ({ config: { name }, state: 'ENABLED' })),
        });
      }
      if (address.includes('artifactregistry.googleapis.com') && address.endsWith(':enable')) {
        return response({ name: address });
      }
      if (address.includes('serviceAccounts')) {
        return response({ error: 'denied' }, 403);
      }
      return response({});
    };
    const result = await provisionGoogleTarget({ target, accessToken: 'token', fetcher });
    expect(result.completed).toEqual(['api:artifactregistry.googleapis.com']);
    expect(result.error).toContain('403');
    expect(calls.at(-1)?.url).toContain('serviceAccounts');
    expect(calls.some((call) => call.url.includes('artifactregistry.googleapis.com/v1'))).toBe(
      false,
    );
  });

  test('Google account creation failure is not mistaken for an already-existing account', async () => {
    const calls: { url: string; method: string }[] = [];
    const plan = googleResourcePlan(target);
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url);
      calls.push({ url: address, method: init?.method ?? 'GET' });
      if (address.includes('serviceusage')) {
        return response({
          services: plan.requiredApis.map((name) => ({ config: { name }, state: 'ENABLED' })),
        });
      }
      if (address.includes('serviceAccounts') && init?.method === 'POST') {
        return response({ error: 'permission denied' }, 403);
      }
      if (address.includes('serviceAccounts')) {
        return response({ accounts: [] });
      }
      return response({});
    };
    const result = await provisionGoogleTarget({ target, accessToken: 'token', fetcher });
    expect(result.error).toContain('403');
    expect(result.completed).toEqual([]);
    expect(
      calls.some((call) => call.method === 'POST' && call.url.includes('serviceAccounts')),
    ).toBe(true);
    expect(calls.some((call) => call.url.includes('artifactregistry.googleapis.com/v1'))).toBe(
      false,
    );
  });

  test('runner identity target uses immutable Google uniqueId, never its mutable email', async () => {
    const result = await getGoogleRunnerSubject({
      target,
      accessToken: 'token',
      fetcher: async () => response({ uniqueId: '12345678901234567890' }),
    });
    expect(result).toBe('12345678901234567890');
    await expect(
      getGoogleRunnerSubject({
        target,
        accessToken: 'token',
        fetcher: async () => response({ email: 'runner@starter-stage.iam.gserviceaccount.com' }),
      }),
    ).rejects.toThrow('uniqueId');
    await expect(
      getGoogleRunnerSubject({
        target,
        accessToken: 'token',
        fetcher: async () => response({ error: 'denied' }, 403),
      }),
    ).rejects.toThrow('403');
  });

  test('image verification requires the immutable configured digest', async () => {
    const result = await verifyGoogleArtifactImage({
      target,
      accessToken: 'token',
      fetcher: async () => response({ name: `dockerImages/runner@sha256:${'a'.repeat(64)}` }),
    });
    expect(result.digest).toBe(`sha256:${'a'.repeat(64)}`);
    await expect(
      verifyGoogleArtifactImage({
        target,
        accessToken: 'token',
        fetcher: async () => response({ name: 'wrong' }),
      }),
    ).rejects.toThrow('did not confirm');
    await expect(
      verifyGoogleArtifactImage({
        target,
        accessToken: 'token',
        fetcher: async () => response({ error: 'image absent' }, 404),
      }),
    ).rejects.toThrow('404');
  });

  test('job apply sends a private finite job on the runner identity', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      if (String(url).includes('artifactregistry')) {
        return response({ name: `x@sha256:${'a'.repeat(64)}` });
      }
      if (init?.method === undefined) {
        return response({ name: 'job' });
      }
      return response({ name: 'job' });
    };
    await applyGoogleJob({ target, accessToken: 'token', fetcher });
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch?.body).toContain(target.supabase?.runnerServiceAccount);
    expect(patch?.body).toContain('600s');
  });

  test('dispatcher IAM mutation grants only the target dispatcher invoker access', async () => {
    let captured: unknown;
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        captured = JSON.parse(String(init?.body));
      }
      return response({ etag: 'e1', bindings: [] });
    };
    await applyDispatcherGrant({ target, accessToken: 'token', fetcher });
    expect(captured).toEqual({
      policy: {
        etag: 'e1',
        bindings: [
          {
            role: 'roles/run.invoker',
            members: ['serviceAccount:dispatch@starter-stage.iam.gserviceaccount.com'],
          },
        ],
      },
    });
    expect(JSON.stringify(captured)).not.toContain('runner@starter-stage.iam.gserviceaccount.com');
  });
});
