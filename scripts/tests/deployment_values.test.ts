import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOYMENT_CONFIG, targets } from '../src/registry/app_registry.ts';
import {
  describeResolution,
  LOCAL_DEPLOYMENT_FILE,
  localConfigProblem,
  resolveDeploymentValues,
  topologyFor,
} from '../src/registry/deployment_values.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), 'starter-supabase-target-'));
  roots.push(value);
  return value;
};

test('a fresh template has no inherited Worker, Supabase, or compute identifiers', () => {
  expect(DEPLOYMENT_CONFIG.workerName).toBeNull();
  const values = resolveDeploymentValues({}, root());
  expect(values.accountId).toBeNull();
  expect(topologyFor('staging', values)?.workerName).toBeNull();
  expect(topologyFor('staging', values)?.supabaseProjectRef).toBeNull();
  expect(topologyFor('staging', values)?.jobsProfile).toBe('disabled');
});

test('per-environment target values remain separate through local overlay resolution', () => {
  const checkout = root();
  const local = join(checkout, LOCAL_DEPLOYMENT_FILE);
  mkdirSync(join(checkout, '.starter'), { recursive: true });
  writeFileSync(
    local,
    JSON.stringify({
      accountId: 'a'.repeat(32),
      environments: {
        staging: {
          ...targets({ workerName: 'web-staging' }),
          supabaseProjectRef: 'stageprojectref00001',
        },
        production: {
          ...targets({ workerName: 'web-production' }),
          supabaseProjectRef: 'prodprojectref000001',
        },
      },
    }),
  );
  const values = resolveDeploymentValues({}, checkout);
  expect(topologyFor('staging', values)?.workerName).toBe('web-staging');
  expect(topologyFor('production', values)?.workerName).toBe('web-production');
  expect(topologyFor('staging', values)?.supabaseProjectRef).toBe('stageprojectref00001');
  expect(topologyFor('production', values)?.supabaseProjectRef).toBe('prodprojectref000001');
});

test('environment overrides are scoped to the named deployment', () => {
  const values = resolveDeploymentValues(
    {
      DEPLOY_ENVIRONMENT: 'staging',
      CLOUDFLARE_WORKER_NAME: 'override-staging',
    },
    root(),
  );
  expect(topologyFor('staging', values)?.workerName).toBe('override-staging');
  expect(topologyFor('production', values)?.workerName).toBeNull();
});

test('resolution reporting names the actual layer for each supported scalar', () => {
  const checkout = root();
  mkdirSync(join(checkout, '.starter'), { recursive: true });
  writeFileSync(join(checkout, LOCAL_DEPLOYMENT_FILE), JSON.stringify({ workerName: 'local-web' }));
  expect(describeResolution('workerName', {}, checkout)).toBe('local-file');
  expect(describeResolution('workerName', { CLOUDFLARE_WORKER_NAME: 'ci-web' }, checkout)).toBe(
    'environment',
  );
  expect(describeResolution('accountId', {}, checkout)).toBe('default');
});

test('malformed local configuration is surfaced instead of silently used', () => {
  const checkout = root();
  mkdirSync(join(checkout, '.starter'), { recursive: true });
  writeFileSync(join(checkout, LOCAL_DEPLOYMENT_FILE), '{broken');
  expect(localConfigProblem(checkout)).toContain('not valid JSON');
});
