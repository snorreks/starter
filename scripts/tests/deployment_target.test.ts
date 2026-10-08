import { describe, expect, test } from 'bun:test';
import { resolveTarget } from '../src/deploy/target.ts';
import { targets } from '../src/registry/app_registry.ts';
import type { DeploymentValues } from '../src/registry/deployment_values.ts';

const ref = (environment: 'staging' | 'production'): string =>
  environment === 'staging' ? 'stageprojectref00001' : 'prodprojectref000001';

const origin = (environment: 'staging' | 'production'): string =>
  environment === 'staging'
    ? 'https://starter-staging.example.workers.dev'
    : 'https://starter.example';

const configured = (
  environment: 'staging' | 'production',
  changes: Record<string, string | null> = {},
) =>
  targets({
    workerName: environment === 'staging' ? 'starter-staging' : 'starter-production',
    origin: origin(environment),
    mailFrom: 'noreply@starter.example',
    nativeApiOrigin: origin(environment),
    jobsProfile: 'disabled',
    supabaseProjectRef: ref(environment),
    supabaseUrl: `https://${ref(environment)}.supabase.co`,
    supabaseAuthUrl: `https://${ref(environment)}.supabase.co`,
    supabasePublishableKey: 'sb_publishable_public-key',
    nativeRedirectAllowlist: `${origin(environment)}/auth/callback,com.example.starter://auth/callback`,
    ...changes,
  });

const values = (
  staging = configured('staging'),
  production = configured('production'),
): DeploymentValues => ({
  accountId: 'abcdef0123456789abcdef0123456789',
  workerName: null,
  r2BucketNames: { uploads: null },
  customDomain: null,
  jobsProfile: 'disabled',
  environments: { staging, production },
});

const enabled = (
  environment: 'staging' | 'production',
  changes: Record<string, string | null> = {},
) =>
  configured(environment, {
    jobsProfile: 'encode',
    containerProfile: 'basic',
    googleProjectId: `starter-${environment}`,
    googleRegion: 'europe-north1',
    cloudRunJobName: `starter-media-${environment}`,
    artifactImage: `europe-north1-docker.pkg.dev/starter-${environment}/media/runner@sha256:${'a'.repeat(64)}`,
    runnerServiceAccount: `runner-${environment}@starter-${environment}.iam.gserviceaccount.com`,
    dispatcherServiceAccount: `dispatch-${environment}@starter-${environment}.iam.gserviceaccount.com`,
    processorProtocol: 'sample-v1',
    processorCpu: '2',
    processorMemory: '2Gi',
    processorTimeoutSeconds: '900',
    jobsWorkerName: `starter-jobs-${environment}`,
    mediaBucketName: `starter-media-${environment}`,
    encodeWorkflowName: `starter-encode-${environment}`,
    maintenanceWorkflowName: `starter-maintenance-${environment}`,
    ...changes,
  });

describe('Supabase is the only deployable application backend', () => {
  test('the enabled negative-control fixture is itself a valid target', () => {
    expect(
      resolveTarget('staging', { values: values(enabled('staging'), enabled('production')) }).ok,
    ).toBe(true);
  });

  test.each([
    ['shared Supabase project', { supabaseProjectRef: ref('production') }, 'Supabase project'],
    ['shared Google project', { googleProjectId: 'starter-production' }, 'Google Cloud project'],
    ['shared bucket', { mediaBucketName: 'starter-media-production' }, 'R2 bucket'],
    [
      'shared runner',
      { runnerServiceAccount: 'runner-production@starter-production.iam.gserviceaccount.com' },
      'runner identity',
    ],
    [
      'foreign callback',
      {
        nativeRedirectAllowlist:
          'https://foreign.example/auth/callback,com.example.starter://auth/callback',
      },
      'redirect allowlist',
    ],
    ['mismatched Auth origin', { supabaseAuthUrl: 'https://other-project.supabase.co' }, 'origins'],
    [
      'API path instead of origin',
      {
        supabaseUrl: 'https://stageprojectref00001.supabase.co/rest/v1',
        supabaseAuthUrl: 'https://stageprojectref00001.supabase.co/rest/v1',
      },
      'HTTPS origins',
    ],
    [
      'mutable image',
      { artifactImage: 'europe-north1-docker.pkg.dev/starter-staging/media/runner:latest' },
      'pinned by digest',
    ],
    ['missing dispatcher', { dispatcherServiceAccount: null }, 'dispatcherServiceAccount'],
  ] as const)('%s is refused before any provider mutation', (_name, changes, reason) => {
    const result = resolveTarget('staging', {
      values: values(enabled('staging', changes), enabled('production')),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(reason);
    }
  });
  test('resolves the public Supabase config and explicit disabled compute from one target', () => {
    const result = resolveTarget('staging', { values: values() });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.target.supabase?.projectRef).toBe(ref('staging'));
    expect(result.target.compute).toMatchObject({ enabled: false, profile: 'disabled' });
    expect(result.target.requiredSecretNames).not.toContain('GOOGLE_DISPATCHER_CREDENTIAL');
  });

  test('different environments cannot share a Supabase project or application Worker', () => {
    const sharedProject = values(
      configured('staging'),
      configured('production', {
        supabaseProjectRef: ref('staging'),
        supabaseUrl: `https://${ref('staging')}.supabase.co`,
        supabaseAuthUrl: `https://${ref('staging')}.supabase.co`,
      }),
    );
    const projectResult = resolveTarget('staging', { values: sharedProject });
    expect(projectResult.ok).toBe(false);
    if (!projectResult.ok) {
      expect(projectResult.reason).toContain('Supabase project');
    }

    const sharedWorker = values(
      configured('staging'),
      configured('production', { workerName: 'starter-staging' }),
    );
    expect(resolveTarget('staging', { values: sharedWorker }).ok).toBe(false);
  });

  test('missing public Supabase settings fail before a deployment can be planned', () => {
    const result = resolveTarget('staging', {
      values: values(configured('staging', { supabaseUrl: null })),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('supabaseUrl');
    }
  });

  test('enabled compute names each missing provider prerequisite', () => {
    const result = resolveTarget('staging', {
      values: values(
        configured('staging', {
          jobsProfile: 'encode',
          googleProjectId: null,
          googleRegion: null,
          cloudRunJobName: null,
          artifactImage: null,
          runnerServiceAccount: null,
          dispatcherServiceAccount: null,
          processorProtocol: null,
          processorCpu: null,
          processorMemory: null,
          processorTimeoutSeconds: null,
          jobsWorkerName: null,
          mediaBucketName: null,
          encodeWorkflowName: null,
          maintenanceWorkflowName: null,
          containerProfile: null,
        }),
      ),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Enabled compute');
      expect(result.reason).toContain('googleProjectId');
    }
  });

  test('an unconfigured fresh template cannot resolve an inherited cloud resource', () => {
    const result = resolveTarget('staging', {
      values: {
        accountId: 'abcdef0123456789abcdef0123456789',
        workerName: null,
        r2BucketNames: { uploads: null },
        customDomain: null,
        jobsProfile: 'disabled',
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('No Worker name');
    }
  });
});
