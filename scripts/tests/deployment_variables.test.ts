// scripts/tests/deployment_variables.test.ts
//
// The CI variable layer: what the plan job can know, and what it must not assume.
//
// Every test here is offline and credential-free by construction — that is not a
// convenience, it is the property under test. `deploy plan` runs on a fork's pull
// request, where there is no secret and no environment to read one from, and the
// bug this file exists for is exactly that a plan can be *wrong* about a fully
// configured project.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobsDeployStep } from '../src/deploy/apply.ts';
import { planDeploy } from '../src/deploy/deploy.ts';
import type { ResolvedTarget } from '../src/deploy/target.ts';
import { resolveTarget } from '../src/deploy/target.ts';
import {
  ACCOUNT_ID_VARIABLE,
  DEPLOY_JOBS,
  DEPLOY_OVERRIDE_VARIABLES,
  deployOverridesFor,
  ENVIRONMENT_MAP_VARIABLE,
  parseEnvironmentMap,
  readRepositoryLayer,
  type ScopedVariable,
  targetFieldVariable,
  visibleVariables,
} from '../src/deploy/variables.ts';
import { targets } from '../src/registry/app_registry.ts';
import { resolveDeploymentValues } from '../src/registry/deployment_values.ts';
import { REPO_ROOT } from '../src/shared/paths.ts';

const ACCOUNT = 'a'.repeat(32);
const publicSettings = (origin: string, projectRef: string) => ({
  nativeApiOrigin: origin,
  supabaseProjectRef: projectRef,
  supabaseUrl: `https://${projectRef}.supabase.co`,
  supabaseAuthUrl: `https://${projectRef}.supabase.co`,
  supabasePublishableKey: `sb_publishable_${projectRef}`,
  nativeRedirectAllowlist: `${origin}/auth/callback,com.example.starter://auth/callback`,
});
const cloudSettings = (name: string) => ({
  googleProjectId: `starter-${name}`,
  googleRegion: 'europe-north1',
  cloudRunJobName: `starter-processor-${name}`,
  artifactImage: `europe-north1-docker.pkg.dev/starter-${name}/processor@sha256:${name === 'staging' ? 'a' : 'b'}${'a'.repeat(63)}`,
  runnerServiceAccount: `runner@starter-${name}.iam.gserviceaccount.com`,
  dispatcherServiceAccount: `dispatcher@starter-${name}.iam.gserviceaccount.com`,
  processorProtocol: 'sample-v1',
  processorCpu: '2',
  processorMemory: '2Gi',
  processorTimeoutSeconds: '900',
});

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A repository-variable environment, as an operator would type it into the UI. */
const repositoryMap = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    staging: {
      workerName: 'starter-staging',
      origin: 'https://staging.example',
      nativeApiOrigin: 'https://staging.example',
      mailFrom: 'noreply@staging.example',
      jobsProfile: 'disabled',
      supabaseProjectRef: 'stageprojectref00001',
      supabaseUrl: 'https://stageprojectref00001.supabase.co',
      supabaseAuthUrl: 'https://stageprojectref00001.supabase.co',
      supabasePublishableKey: 'sb_publishable_staging',
      nativeRedirectAllowlist:
        'https://staging.example/auth/callback,com.example.starter://auth/callback',
      ...extra,
    },
    production: {
      workerName: 'starter-production',
      origin: 'https://app.example',
      nativeApiOrigin: 'https://app.example',
      mailFrom: 'noreply@app.example',
      jobsProfile: 'disabled',
      supabaseProjectRef: 'prodprojectref000001',
      supabaseUrl: 'https://prodprojectref000001.supabase.co',
      supabaseAuthUrl: 'https://prodprojectref000001.supabase.co',
      supabasePublishableKey: 'sb_publishable_production',
      nativeRedirectAllowlist:
        'https://app.example/auth/callback,com.example.starter://auth/callback',
    },
  });

describe('the repository environment map', () => {
  test('resolves staging and production to different destinations with no credential', () => {
    // The whole point of repository-scoped configuration: a plan job with no
    // environment and no secret still knows exactly what it would change.
    const env = { [ACCOUNT_ID_VARIABLE]: ACCOUNT, [ENVIRONMENT_MAP_VARIABLE]: repositoryMap() };
    const values = resolveDeploymentValues(env, REPO_ROOT);

    const staging = resolveTarget('staging', { values });
    const production = resolveTarget('production', { values });

    expect(staging.ok).toBe(true);
    expect(production.ok).toBe(true);
    if (!staging.ok || !production.ok) {
      throw new Error(
        `${staging.ok ? '' : staging.reason}${production.ok ? '' : production.reason}`,
      );
    }

    expect(staging.target.workerName).toBe('starter-staging');
    expect(production.target.workerName).toBe('starter-production');
    expect(staging.target.supabase.projectRef).not.toBe(production.target.supabase.projectRef);
    expect(staging.target.origin).toBe('https://staging.example');
    expect(production.target.origin).toBe('https://app.example');
  });

  test('two plans from the same variables describe different work', () => {
    // A temporary tree with a wrangler.jsonc naming each environment's database, so
    // `migrationStep` — which refuses when the committed config and the resolved
    // target disagree — is reached rather than short-circuiting the plan.
    const root = mkdtempSync(join(tmpdir(), 'starter-vars-'));
    created.push(root);
    const configDir = join(root, 'apps/frontend/client');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'starter',
        main: '.svelte-kit/cloudflare/_worker.js',
        assets: { directory: '.svelte-kit/cloudflare', binding: 'ASSETS' },
        d1_databases: [{ binding: 'DB', database_name: 'starter' }],
        env: {
          staging: { d1_databases: [{ binding: 'DB', database_id: 'db-staging' }] },
          production: { d1_databases: [{ binding: 'DB', database_id: 'db-production' }] },
        },
      }),
    );

    const values = resolveDeploymentValues(
      { [ACCOUNT_ID_VARIABLE]: ACCOUNT, [ENVIRONMENT_MAP_VARIABLE]: repositoryMap() },
      root,
    );

    const staging = planDeploy('staging', { values, hasCredential: false, root });
    const production = planDeploy('production', { values, hasCredential: false, root });

    expect(staging.ok).toBe(true);
    expect(production.ok).toBe(true);
    if (!staging.ok) {
      throw new Error(staging.reason);
    }
    if (!production.ok) {
      throw new Error(production.reason);
    }

    const stagingArgv = JSON.stringify(staging.steps.map((step) => step.args));
    const productionArgv = JSON.stringify(production.steps.map((step) => step.args));

    expect(stagingArgv).toContain('starter-staging');
    expect(stagingArgv).not.toContain('starter-production');
    expect(productionArgv).toContain('starter-production');
    expect(stagingArgv).not.toBe(productionArgv);
  });

  test('a per-field repository variable overrides one field and leaves the rest alone', () => {
    // The operator who keeps configuration in the settings UI one row at a time.
    const env = {
      [ACCOUNT_ID_VARIABLE]: ACCOUNT,
      [ENVIRONMENT_MAP_VARIABLE]: repositoryMap(),
      [targetFieldVariable('staging', 'origin')]: 'https://staging.example.test',
    };

    const layer = readRepositoryLayer(env).map;
    expect(layer.staging?.origin).toBe('https://staging.example.test');
    // The fields the override did not mention are still the map's.
    expect(layer.staging?.workerName).toBe('starter-staging');
    expect(layer.production?.origin).toBe('https://app.example');
  });

  test('the field variable name is greppable and unambiguous', () => {
    expect(targetFieldVariable('staging', 'mediaBucketName')).toBe(
      'STARTER_STAGING_MEDIA_BUCKET_NAME',
    );
    expect(targetFieldVariable('production', 'containerImage')).toBe(
      'STARTER_PRODUCTION_CONTAINER_IMAGE',
    );
  });
});

describe('a malformed map is refused, not half-read', () => {
  test('an unknown field names itself and the valid ones', () => {
    const result = parseEnvironmentMap(
      JSON.stringify({ staging: { workerName: 'a', workrName: 'b' } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected a refusal');
    }
    expect(result.problems[0]?.message).toContain('workrName');
    expect(result.problems[0]?.remedy).toContain('workerName');
  });

  test('an unknown environment is refused rather than ignored', () => {
    // Ignored, the entry would silently describe nothing, and the plan would be
    // about an environment this project has never heard of.
    const result = parseEnvironmentMap(JSON.stringify({ prod: { workerName: 'a' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]?.message).toContain('"prod" is not a deployable environment');
    }
  });

  test('an empty string is refused as "not provisioned" rather than accepted', () => {
    const result = parseEnvironmentMap(JSON.stringify({ staging: { workerName: '' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]?.message).toContain('empty string');
      expect(result.problems[0]?.remedy).toContain('null');
    }
  });

  test('a credential-looking field is refused by name, because the map is echoed', () => {
    // The resolved target is printed by `deploy plan` and written into a release
    // record that is uploaded as an artifact. A secret in the map would be in both.
    const result = parseEnvironmentMap(
      JSON.stringify({ staging: { workerName: 'a', BETTER_AUTH_SECRET: 'x' } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]?.message).toContain('looks like a credential');
    }
  });

  test('invalid JSON names the variable and shows the shape', () => {
    const result = parseEnvironmentMap('{ staging: ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]?.message).toContain(ENVIRONMENT_MAP_VARIABLE);
      expect(result.problems[0]?.remedy).toContain('workerName');
    }
  });

  test('a mistyped field reaches the plan as a named refusal, not as "not configured"', () => {
    // The failure this fixes: the map was parsed away, the whole thing read as empty,
    // and `deploy status` told the operator no Worker name was configured — four
    // steps away from the typo that actually caused it.
    const values = resolveDeploymentValues(
      {
        [ACCOUNT_ID_VARIABLE]: ACCOUNT,
        [ENVIRONMENT_MAP_VARIABLE]: JSON.stringify({
          staging: {
            workerName: 'starter-staging',
            workrName: 'typo',
            origin: 'https://a.example',
            mailFrom: 'n@x.example',
            jobsProfile: 'disabled',
          },
          production: {
            workerName: 'starter-prod',
            origin: 'https://b.example',
            mailFrom: 'n@x.example',
            jobsProfile: 'disabled',
          },
        }),
      },
      REPO_ROOT,
    );

    const staging = resolveTarget('staging', { values });
    expect(staging.ok).toBe(false);
    if (!staging.ok) {
      expect(staging.reason).toContain('workrName');
      expect(staging.reason).toContain('workerName');
      expect(staging.remedy).toContain('repository variable');
    }
  });

  test('a typo in one environment does not block the other', () => {
    const values = resolveDeploymentValues(
      {
        [ACCOUNT_ID_VARIABLE]: ACCOUNT,
        [ENVIRONMENT_MAP_VARIABLE]: JSON.stringify({
          staging: {
            workerName: 'starter-staging',
            origin: 'https://a.example',
            mailFrom: 'n@x.example',
            jobsProfile: 'disabled',
            ...publicSettings('https://a.example', 'stageprojectref00001'),
          },
          production: {
            workerName: 'starter-prod',
            origin: 'https://b.example',
            mailFrom: 'n@x.example',
            jobsProfile: 'disabled',
            workrName: 'typo',
            ...publicSettings('https://b.example', 'prodprojectref000001'),
          },
        }),
      },
      REPO_ROOT,
    );

    // Staging is plannable; production names its own mistake. Blocking both would
    // mean one typo stops a working environment from shipping.
    const staging = resolveTarget('staging', { values });
    if (!staging.ok) {
      throw new Error(staging.reason);
    }
    expect(staging.ok).toBe(true);
    const production = resolveTarget('production', { values });
    expect(production.ok).toBe(false);
  });

  test('an absent map is not an error; it is "this project has provisioned nothing"', () => {
    // A fresh clone has no variables at all, and the refusal that follows has to
    // come from `resolveTarget` naming the missing Worker — not from the variable
    // parser rejecting an empty process environment.
    const result = parseEnvironmentMap(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.map).toEqual({});
    }
  });
});

describe('the unsuffixed overrides apply to one environment, never to both', () => {
  test('without DEPLOY_ENVIRONMENT nothing is injected', () => {
    // This is the fix, stated as a test. The old code applied `CLOUDFLARE_WORKER_NAME`
    // to every environment, so `environmentIsolationProblem` compared one value with
    // itself and every plan in CI refused with "staging and production share a Worker".
    expect(deployOverridesFor(undefined, { CLOUDFLARE_WORKER_NAME: 'starter' })).toEqual({});
    expect(deployOverridesFor('', { CLOUDFLARE_WORKER_NAME: 'starter' })).toEqual({});
    expect(deployOverridesFor('local', { CLOUDFLARE_WORKER_NAME: 'starter' })).toEqual({});
  });

  test('with it, the override lands on that environment only', () => {
    const overrides = deployOverridesFor('staging', {
      CLOUDFLARE_WORKER_NAME: 'ci-staging',
    });

    expect(overrides.workerName).toBe('ci-staging');
  });

  test('a CI run that sets the overrides still plans both environments without claiming they are shared', () => {
    const values = resolveDeploymentValues(
      {
        [ACCOUNT_ID_VARIABLE]: ACCOUNT,
        [ENVIRONMENT_MAP_VARIABLE]: repositoryMap(),
        DEPLOY_ENVIRONMENT: 'staging',
        CLOUDFLARE_WORKER_NAME: 'starter-staging',
      },
      REPO_ROOT,
    );

    const staging = resolveTarget('staging', { values });
    const production = resolveTarget('production', { values });

    expect(staging.ok).toBe(true);
    expect(production.ok).toBe(true);
    if (staging.ok && production.ok) {
      // The injected values describe the run's own environment; production still
      // resolves from configuration, which is the only thing worth comparing.
      expect(staging.target.workerName).toBe('starter-staging');
      expect(production.target.workerName).toBe('starter-production');
    }
  });

  test('an override that conflicts with configuration still resolves, and the plan names the override', () => {
    // Not a refusal: an operator overriding the configured Worker for one run is a
    // legitimate thing to do. What matters is that the plan prints the name that
    // will actually be deployed.
    const values = resolveDeploymentValues(
      {
        [ACCOUNT_ID_VARIABLE]: ACCOUNT,
        [ENVIRONMENT_MAP_VARIABLE]: repositoryMap(),
        DEPLOY_ENVIRONMENT: 'staging',
        CLOUDFLARE_WORKER_NAME: 'ci-staging-ephemeral',
      },
      REPO_ROOT,
    );

    const resolved = resolveTarget('staging', { values });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }
    expect(resolved.target.workerName).toBe('ci-staging-ephemeral');
  });

  test("an override may not land on another environment's configured destination", () => {
    // The control for the security finding. `environmentIsolationProblem` compares
    // *configured* topology, because the injected overrides are scoped to one
    // environment — which left a gap: a staging override naming production's Worker
    // escaped the comparison entirely and deployed to production under a staging label.
    const values = resolveDeploymentValues(
      {
        [ACCOUNT_ID_VARIABLE]: ACCOUNT,
        [ENVIRONMENT_MAP_VARIABLE]: repositoryMap(),
        DEPLOY_ENVIRONMENT: 'staging',
        // A staging run pointed at production's configured Worker.
        CLOUDFLARE_WORKER_NAME: 'starter-production',
      },
      REPO_ROOT,
    );

    const staging = resolveTarget('staging', { values });
    expect(staging.ok).toBe(false);
    if (!staging.ok) {
      expect(staging.reason).toContain('starter-production');
      expect(staging.reason).toContain("production's configured Worker");
      expect(staging.reason).toContain('Nothing has been changed');
    }
  });

  test('the same override on an unclaimed Worker is still allowed', () => {
    // The check must refuse *collisions*, not overrides. Otherwise the only way to
    // deploy a fresh environment is to write it into the committed configuration.
    const values = resolveDeploymentValues(
      {
        [ACCOUNT_ID_VARIABLE]: ACCOUNT,
        [ENVIRONMENT_MAP_VARIABLE]: repositoryMap(),
        DEPLOY_ENVIRONMENT: 'staging',
        CLOUDFLARE_WORKER_NAME: 'staging-ephemeral',
      },
      REPO_ROOT,
    );
    const staging = resolveTarget('staging', { values });
    expect(staging.ok).toBe(true);
    if (staging.ok) {
      expect(staging.target.workerName).toBe('staging-ephemeral');
    }
  });

  test('every override variable maps to a real target field', () => {
    // A table entry naming a field that does not exist would inject into a field
    // nobody reads, and the operator would believe the run was overridden.
    const fields: string[] = [
      'workerName',
      'jobsWorkerName',
      'mediaBucketName',
      'origin',
      'mailFrom',
      'nativeApiOrigin',
    ];
    for (const field of Object.values(DEPLOY_OVERRIDE_VARIABLES)) {
      expect(fields).toContain(field);
    }
  });
});

describe("GitHub's variable scope", () => {
  // A project configured the documented way: the nonsecret map on the repository,
  // the secrets on the protected environments.
  const configured: ScopedVariable[] = [
    { name: ENVIRONMENT_MAP_VARIABLE, scope: 'repository' },
    { name: ACCOUNT_ID_VARIABLE, scope: 'repository' },
    { name: 'CLOUDFLARE_API_TOKEN', scope: { environment: 'staging' } },
    { name: 'CLOUDFLARE_API_TOKEN', scope: { environment: 'production' } },
  ];

  test('a job with no environment sees the repository configuration and no secret', () => {
    // The plan job. This is the property that lets a plan be reviewed by someone
    // with no deploy authority at all.
    const visible = visibleVariables(DEPLOY_JOBS[0], configured);
    expect(visible).toContain(ENVIRONMENT_MAP_VARIABLE);
    expect(visible).not.toContain('CLOUDFLARE_API_TOKEN');
  });

  test("a job with an environment additionally sees that environment's secret", () => {
    const visible = visibleVariables({ name: 'apply', environment: 'staging' }, configured);
    expect(visible).toContain('CLOUDFLARE_API_TOKEN');
    expect(visible).toContain(ENVIRONMENT_MAP_VARIABLE);
  });

  test('the two named jobs are the ones the workflow declares', () => {
    expect(DEPLOY_JOBS.map((job) => job.name)).toEqual(['plan', 'apply']);
    expect(DEPLOY_JOBS[0].environment).toBeNull();
  });

  test('an environment-scoped *configuration* variable would be invisible to the plan job', () => {
    // The configuration this repository does not use, asserted so the reason it
    // does not use it is recorded rather than rediscovered.
    const misconfigured: ScopedVariable[] = [
      { name: 'CLOUDFLARE_D1_DATABASE_ID', scope: { environment: 'staging' } },
    ];

    expect(visibleVariables({ name: 'plan', environment: null }, misconfigured)).toEqual([]);
    expect(visibleVariables({ name: 'apply', environment: 'staging' }, misconfigured)).toEqual([
      'CLOUDFLARE_D1_DATABASE_ID',
    ]);
  });
});

describe('the compute half resolves from the same variables', () => {
  test('an encode environment resolves every identity the encode path needs', () => {
    const map = JSON.stringify({
      staging: {
        workerName: 'starter-staging',
        jobsWorkerName: 'starter-jobs-staging',
        mediaBucketName: 'starter-media-staging',
        encodeWorkflowName: 'starter-encode-staging',
        maintenanceWorkflowName: 'starter-maintenance-staging',
        containerImage: '../media/Dockerfile',
        imageProtocol: 'sample-v1',
        containerProfile: 'basic',
        jobsProfile: 'encode',
        origin: 'https://staging.example',
        mailFrom: 'noreply@staging.example',
        ...publicSettings('https://staging.example', 'stageprojectref00001'),
        ...cloudSettings('staging'),
      },
    });

    const resolved = resolveTarget('staging', {
      values: resolveDeploymentValues(
        { [ACCOUNT_ID_VARIABLE]: ACCOUNT, [ENVIRONMENT_MAP_VARIABLE]: map },
        REPO_ROOT,
      ),
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }
    const compute = resolved.target.compute;
    expect(compute.enabled).toBe(true);
    expect(compute.jobsWorkerName).toBe('starter-jobs-staging');
    expect(compute.mediaBucketName).toBe('starter-media-staging');
    expect(compute.imageProtocol).toBe('sample-v1');
    expect(compute.containerProfile).toBe('basic');
  });

  test('two environments may build from one Dockerfile without being called shared', () => {
    // The image is a build input, not a per-environment resource. Refusing it here
    // would make a correct two-environment configuration impossible.
    const values = {
      accountId: ACCOUNT,
      workerName: null,
      r2BucketNames: { uploads: null },
      customDomain: null,
      jobsProfile: 'disabled' as const,
      environments: {
        staging: targets({
          workerName: 'web-staging',
          jobsWorkerName: 'jobs-staging',
          mediaBucketName: 'media-staging',
          encodeWorkflowName: 'encode-staging',
          maintenanceWorkflowName: 'maint-staging',
          containerImage: '../media/Dockerfile',
          imageProtocol: 'sample-v1',
          containerProfile: 'basic',
          jobsProfile: 'encode',
          origin: 'https://staging.example',
          mailFrom: 'noreply@staging.example',
          ...publicSettings('https://staging.example', 'stageprojectref00001'),
          ...cloudSettings('staging'),
        }),
        production: targets({
          workerName: 'web-production',
          jobsWorkerName: 'jobs-production',
          mediaBucketName: 'media-production',
          encodeWorkflowName: 'encode-production',
          maintenanceWorkflowName: 'maint-production',
          containerImage: '../media/Dockerfile',
          imageProtocol: 'sample-v1',
          containerProfile: 'basic',
          jobsProfile: 'encode',
          origin: 'https://app.example',
          mailFrom: 'noreply@app.example',
          ...publicSettings('https://app.example', 'prodprojectref000001'),
          ...cloudSettings('production'),
        }),
      },
    };

    const staging = resolveTarget('staging', { values });
    if (!staging.ok) {
      throw new Error(staging.reason);
    }
    expect(staging.ok).toBe(true);

    const pinned: typeof values = {
      ...values,
      environments: {
        staging: targets({ ...values.environments?.staging, containerImage: '@sha256:abc' }),
        production: targets({ ...values.environments?.production, containerImage: '@sha256:abc' }),
      },
    };
    const shared = resolveTarget('production', { values: pinned });
    expect(shared.ok).toBe(false);
    if (!shared.ok) {
      expect(shared.reason).toContain('pinned image digest');
    }
  });
});

describe('the plan names everything the pipeline will change', () => {
  const treeWithConfig = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'starter-plan-'));
    created.push(dir);
    const client = join(dir, 'apps/frontend/client');
    mkdirSync(join(client, '..', '..', 'backend/jobs'), { recursive: true });
    mkdirSync(client, { recursive: true });
    writeFileSync(
      join(client, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'starter',
        main: '.svelte-kit/cloudflare/_worker.js',
        assets: { directory: '.svelte-kit/cloudflare', binding: 'ASSETS' },
        d1_databases: [{ binding: 'DB', database_name: 'starter' }],
        env: { staging: { d1_databases: [{ binding: 'DB', database_id: 'db-staging' }] } },
      }),
    );
    return dir;
  };

  const encodeMap = (): string =>
    JSON.stringify({
      staging: {
        workerName: 'starter-staging',
        jobsWorkerName: 'starter-jobs-staging',
        mediaBucketName: 'starter-media-staging',
        encodeWorkflowName: 'starter-encode-staging',
        maintenanceWorkflowName: 'starter-maintenance-staging',
        containerImage: '../media/Dockerfile',
        imageProtocol: 'sample-v1',
        containerProfile: 'basic',
        jobsProfile: 'encode',
        origin: 'https://staging.example',
        mailFrom: 'noreply@staging.example',
        ...publicSettings('https://staging.example', 'stageprojectref00001'),
        ...cloudSettings('staging'),
      },
    });

  test('a compute environment plans the jobs Worker deploy, not only the web one', () => {
    // The plan is what an approval is given against. It used to describe a migration
    // and a web deploy while `apply` also built an image and deployed a second Worker.
    const root = treeWithConfig();
    const plan = planDeploy('staging', {
      values: resolveDeploymentValues(
        { [ACCOUNT_ID_VARIABLE]: ACCOUNT, [ENVIRONMENT_MAP_VARIABLE]: encodeMap() },
        root,
      ),
      hasCredential: false,
      root,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      throw new Error(plan.reason);
    }

    const rendered = JSON.stringify(plan.steps.map((step) => step.args));
    expect(rendered).toContain('starter-jobs-staging');
    expect(rendered).toContain('starter-staging');
    // The jobs Worker is deployed *before* the web Worker, because the web Worker
    // binds its Workflows.
    const jobsIndex = plan.steps.findIndex((step) => step.args.includes('starter-jobs-staging'));
    const webIndex = plan.steps.findIndex((step) => step.args.includes('starter-staging'));
    expect(jobsIndex).toBeGreaterThan(-1);
    expect(jobsIndex).toBeLessThan(webIndex);
  });

  test('the plan argv is the argv apply executes', () => {
    const root = treeWithConfig();
    const target = resolveTarget('staging', {
      values: resolveDeploymentValues(
        { [ACCOUNT_ID_VARIABLE]: ACCOUNT, [ENVIRONMENT_MAP_VARIABLE]: encodeMap() },
        root,
      ),
    });
    expect(target.ok).toBe(true);
    if (!target.ok) {
      throw new Error(target.reason);
    }

    const step = jobsDeployStep(target.target, 'abc123', root);
    expect(step?.args).toEqual([
      'deploy',
      '--name',
      'starter-jobs-staging',
      '--config',
      join(root, '.starter/deploy/staging-jobs.json'),
      '--var',
      'RELEASE:abc123',
    ]);
  });

  test('a web-only environment plans no jobs Worker at all', () => {
    const root = treeWithConfig();
    const plan = planDeploy('staging', {
      values: resolveDeploymentValues(
        {
          [ACCOUNT_ID_VARIABLE]: ACCOUNT,
          [ENVIRONMENT_MAP_VARIABLE]: JSON.stringify({
            staging: {
              workerName: 'starter-staging',
              origin: 'https://staging.example',
              mailFrom: 'noreply@staging.example',
              jobsProfile: 'disabled',
              ...publicSettings('https://staging.example', 'stageprojectref00001'),
            },
          }),
        },
        root,
      ),
      hasCredential: false,
      root,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      throw new Error(plan.reason);
    }
    expect(JSON.stringify(plan.steps)).not.toContain('starter-jobs');
  });
});

describe('the target keeps every value a plan and a release record print', () => {
  test('a resolved target carries the compute identities and the native origin', () => {
    const values = resolveDeploymentValues(
      {
        [ACCOUNT_ID_VARIABLE]: ACCOUNT,
        [ENVIRONMENT_MAP_VARIABLE]: JSON.stringify({
          staging: {
            workerName: 'starter-staging',
            origin: 'https://staging.example',
            mailFrom: 'noreply@staging.example',
            jobsProfile: 'disabled',
            nativeApiOrigin: 'https://staging.example',
            supabaseProjectRef: 'stageprojectref00001',
            supabaseUrl: 'https://stageprojectref00001.supabase.co',
            supabaseAuthUrl: 'https://stageprojectref00001.supabase.co',
            supabasePublishableKey: 'sb_publishable_stageprojectref00001',
            nativeRedirectAllowlist:
              'https://staging.example/auth/callback,com.example.starter://auth/callback',
          },
        }),
      },
      REPO_ROOT,
    );

    const resolved = resolveTarget('staging', { values });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }

    const target: ResolvedTarget = resolved.target;
    expect(target.compute.enabled).toBe(false);
    expect(target.nativeApiOrigin).toBe('https://staging.example');
    expect(target.jobsWranglerConfig).toBe('apps/backend/jobs/wrangler.jsonc');
    expect(target.mailFrom).toBe('noreply@staging.example');
  });
});
