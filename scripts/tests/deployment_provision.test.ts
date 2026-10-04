// scripts/tests/deployment_provision.test.ts
//
// Provisioning, fixture upload and secret installation — before anything is
// mutated, and with the values that must never appear anywhere.
//
// The negative controls here are the point. A provisioning path is a sequence of
// subprocesses whose arguments are visible to every process on the host, so the
// failure this file exists to prevent is a *silent* one: a secret that reached
// argv, a bucket that was created twice because the existence check did not fire,
// or a run that reported success without installing anything.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bucketExists,
  describeTokenScopes,
  FIXTURE_KEY,
  fixtureUploadStep,
  provision,
  provisionSteps,
  renderProvision,
  secretInArgvProblem,
  secretPlan,
} from '../src/deploy/provision.ts';
import type { ResolvedTarget } from '../src/deploy/target.ts';
import { REQUIRED_TOKEN_SCOPES } from '../src/registry/app_registry.ts';

const created: string[] = [];
const cleanup = (): void => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
};

const target = (overrides: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  environment: 'staging',
  project: 'starter',
  accountId: 'a'.repeat(32),
  workerName: 'starter-staging',
  d1DatabaseId: 'db-staging',
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
  mailFrom: 'noreply@staging.example',
  nativeApiOrigin: null,
  requiredSecretNames: ['BETTER_AUTH_SECRET', 'RESEND_API_KEY'],
  requiredVarNames: ['DEPLOYMENT_ENV', 'BETTER_AUTH_URL', 'MAIL_FROM', 'RELEASE'],
  ...overrides,
});

const encodeTarget = target({
  compute: {
    enabled: true,
    profile: 'encode',
    jobsWorkerName: 'starter-jobs-staging',
    mediaBucketName: 'starter-media-staging',
    encodeWorkflowName: 'starter-encode-staging',
    maintenanceWorkflowName: 'starter-maintenance-staging',
    containerImage: '../media/Dockerfile',
    imageProtocol: 'sample-v1',
    containerProfile: 'basic',
  },
});

const tree = (withFixture: boolean): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-provision-'));
  created.push(root);
  if (withFixture) {
    const dir = join(root, 'apps/backend/media/fixtures');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sample-v1.mp4'), 'not really an mp4');
  }
  return root;
};

describe('a secret never reaches argv', () => {
  test('a value-shaped argument is refused by name', () => {
    expect(secretInArgvProblem(['secret', 'put', 'BETTER_AUTH_SECRET'])).toBeNull();
    expect(secretInArgvProblem(['--var', 'X:re_abcdef123456'])).toContain(
      'looks like a credential',
    );
    expect(secretInArgvProblem(['--text', 'v1.0-abcdefghij'])).toContain('looks like a credential');
    expect(secretInArgvProblem(['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'])).toContain(
      'looks like a credential',
    );
  });

  test('the secret plan carries names and argv, and no value field at all', () => {
    // Not "the value is redacted when printed": there is nowhere for it to be. The
    // structure has no key a value could occupy.
    const plan = secretPlan(encodeTarget, 'env');
    expect(plan.map((entry) => entry.name)).toEqual(['BETTER_AUTH_SECRET', 'RESEND_API_KEY']);
    for (const entry of plan) {
      expect(Object.keys(entry).sort()).toEqual(['argv', 'envVar', 'name', 'source', 'workerName']);
      expect(JSON.stringify(entry)).not.toContain('hunter2');
    }
  });

  test('installation passes the value on stdin and the name in argv', () => {
    const seen: { args: readonly string[]; stdin?: string }[] = [];
    provision(encodeTarget, {
      root: tree(true),
      capture: () => ({ ok: true, stdout: '[]', stderr: '' }),
      env: { BETTER_AUTH_SECRET: 'super-secret-value', RESEND_API_KEY: 're_realvalue' },
      installSecrets: true,
      run: (args, options) => {
        seen.push({ args: [...args], stdin: options.stdin });
        return { ok: true, detail: 'ok' };
      },
    });

    const installs = seen.filter((call) => call.args[0] === 'secret');
    expect(installs).toHaveLength(2);
    for (const call of installs) {
      expect(call.stdin).toBeDefined();
      expect(call.args.join(' ')).not.toContain('super-secret-value');
      expect(call.args.join(' ')).not.toContain('re_realvalue');
    }
    expect(seen.map((call) => call.args.join(' ')).join('\n')).not.toContain('super-secret-value');
  });

  test('a rendered report cannot contain a value, because no step holds one', () => {
    const result = provision(encodeTarget, {
      root: tree(true),
      capture: () => ({ ok: true, stdout: '[]', stderr: '' }),
      env: { BETTER_AUTH_SECRET: 'super-secret-value', RESEND_API_KEY: 're_realvalue' },
      installSecrets: true,
      run: () => ({ ok: true, detail: 'ok' }),
    });

    const rendered = renderProvision(result);
    expect(rendered).toContain('BETTER_AUTH_SECRET');
    expect(rendered).not.toContain('super-secret-value');
    expect(rendered).not.toContain('re_realvalue');
  });
});

describe('the Cloudflare token is not a runtime secret', () => {
  test('a missing runtime secret is named, and the deployment credential is not offered as a substitute', () => {
    const runs: string[][] = [];
    const result = provision(encodeTarget, {
      root: tree(true),
      capture: () => ({ ok: true, stdout: '[]', stderr: '' }),
      // The credential a CI run actually has.
      env: { CLOUDFLARE_API_TOKEN: 'cf-token-value' },
      installSecrets: true,
      run: (args) => {
        runs.push([...args]);
        return { ok: true, detail: 'ok' };
      },
    });

    expect(result.ok).toBe(false);
    // It stopped at the first secret: the Cloudflare token was not accepted in its
    // place and no `secret put` was run.
    expect(runs.some((args) => args[0] === 'secret')).toBe(false);
    expect(result.stoppedAt).toBe('secret:BETTER_AUTH_SECRET');
    const detail =
      result.steps.find((step) => step.name === 'secret:BETTER_AUTH_SECRET')?.detail ?? '';
    expect(detail).toContain('CLOUDFLARE_API_TOKEN authorises this tooling');
    expect(detail).toContain('not the runtime secret');
    cleanup();
  });
});

describe('provisioning is idempotent', () => {
  test('an existing database and bucket are reported as already, and nothing is created', () => {
    const created_: string[] = [];
    const result = provision(encodeTarget, {
      root: tree(true),
      capture: (args) =>
        args[0] === 'r2'
          ? { ok: true, stdout: JSON.stringify([{ name: 'starter-media-staging' }]), stderr: '' }
          : { ok: true, stdout: '{"uuid":"db-staging"}', stderr: '' },
      env: {},
      run: (args) => {
        created_.push(args.join(' '));
        return { ok: true, detail: 'ok' };
      },
    });

    const database = result.steps.find((step) => step.name === 'database');
    const bucket = result.steps.find((step) => step.name === 'bucket');
    expect(database?.outcome).toBe('already');
    expect(bucket?.outcome).toBe('already');
    // The only remaining call is the fixture upload, which overwrites identical
    // bytes and is therefore safe to repeat.
    expect(created_.every((line) => line.startsWith('r2 object put'))).toBe(true);
    cleanup();
  });

  test('a missing resource is created, and the failure of one stops the next', () => {
    const created_: string[] = [];
    const result = provision(encodeTarget, {
      root: tree(true),
      // Neither resource exists yet, so both `exists` probes come back empty.
      capture: (args) =>
        args[0] === 'r2'
          ? { ok: true, stdout: '[]', stderr: '' }
          : { ok: false, stdout: '', stderr: 'not found' },
      env: {},
      run: (args) => {
        created_.push(args.join(' '));
        return { ok: false, detail: 'provider refused' };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('database');
    // Everything before the failure ran; nothing after it did.
    expect(created_).toEqual(['d1 create starter-staging-db --type primary']);
    expect(result.steps.map((step) => step.name)).toEqual(['database']);
    cleanup();
  });

  test('a bucket name that merely shares a prefix is not mistaken for the bucket', () => {
    // `grep`-ing JSON for a name would match `starter-media-staging-old` and skip
    // the create, leaving the encode path writing to a bucket that does not exist.
    const listed = JSON.stringify([{ name: 'starter-media-staging-old' }]);
    expect(bucketExists(listed, 'starter-media-staging')).toBe(false);
    expect(
      bucketExists(JSON.stringify([{ name: 'starter-media-staging' }]), 'starter-media-staging'),
    ).toBe(true);
    // Unparseable output is "cannot tell", and "cannot tell" must never become
    // "already exists".
    expect(bucketExists('not json', 'starter-media-staging')).toBe(false);
  });

  test('a web-only target provisions a database and nothing else', () => {
    const result = provision(target(), {
      root: tree(false),
      capture: () => ({ ok: true, stdout: '{}', stderr: '' }),
      env: {},
      run: () => ({ ok: true, detail: 'ok' }),
    });

    expect(result.steps.map((step) => step.name)).toEqual([
      'database',
      'secret:BETTER_AUTH_SECRET',
      'secret:RESEND_API_KEY',
    ]);
    cleanup();
  });
});

describe('the fixture upload is refused when the fixture was never built', () => {
  test('the remedy names the command that generates it', () => {
    const result = provision(encodeTarget, {
      root: tree(false),
      capture: (args) =>
        args[0] === 'r2'
          ? { ok: true, stdout: JSON.stringify([{ name: 'starter-media-staging' }]), stderr: '' }
          : { ok: true, stdout: '{}', stderr: '' },
      env: {},
      run: () => ({ ok: true, detail: 'ok' }),
    });

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('fixture');
    const fixture = result.steps.find((step) => step.name === 'fixture');
    expect(fixture?.detail).toContain('bun run --cwd apps/backend/media fixture');
    expect(fixture?.detail).toContain('Nothing was uploaded');
    cleanup();
  });

  test('the fixture key is a constant, not something a caller supplies', () => {
    const step = fixtureUploadStep(encodeTarget);
    expect(step?.argv[3]).toBe(`starter-media-staging/${FIXTURE_KEY}`);
    expect(step?.argv).toContain('--remote');
    // A web-only target has no bucket, so there is no upload to plan.
    expect(fixtureUploadStep(target())).toBeNull();
  });
});

describe('the token scopes come from the operations', () => {
  test('every scope names the call that needs it', () => {
    // A scope list with no provenance is a list nobody can review when a step is
    // added and the deploy starts failing with a 403.
    for (const scope of REQUIRED_TOKEN_SCOPES) {
      expect(scope.neededBy.length).toBeGreaterThan(10);
      expect(scope.permission).toMatch(/:/);
    }
    expect(describeTokenScopes()).toContain('D1: Edit');
    expect(describeTokenScopes()).toContain('R2: Edit');
  });

  test('the resource steps name the same resources the target resolves', () => {
    const names = provisionSteps(encodeTarget).map((step) => step.name);
    expect(names).toEqual(['database', 'bucket']);
    expect(provisionSteps(target()).map((step) => step.name)).toEqual(['database']);
  });
});

describe('SOPS is refused here, with the composition that works', () => {
  test('the refusal points at secrets:exec rather than adding a second decrypt path', () => {
    const result = provision(encodeTarget, {
      root: tree(true),
      capture: () => ({
        ok: true,
        stdout: JSON.stringify([{ name: 'starter-media-staging' }]),
        stderr: '',
      }),
      env: {},
      secretSource: 'sops',
      run: () => ({ ok: true, detail: 'ok' }),
    });

    expect(result.ok).toBe(false);
    const detail = result.steps.find((step) => step.name === 'secrets')?.detail ?? '';
    expect(detail).toContain('bun run secrets:exec');
    expect(detail).toContain('Nothing was installed');
    cleanup();
  });
});
