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

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mediaFixtureKey, PROCESSOR_FIXTURE_ID } from '@starter/schemas/jobs';
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
import { remoteConfigPath } from '../src/deploy/remote_config.ts';
import type { ResolvedTarget } from '../src/deploy/target.ts';
import { REQUIRED_TOKEN_SCOPES } from '../src/registry/app_registry.ts';
import { REPO_ROOT } from '../src/shared/paths.ts';
import { testTarget } from './fixtures/deployment_target.ts';

const created: string[] = [];
const cleanup = (): void => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
};

// Registered rather than called at the end of each test: a failing assertion used to
// skip the cleanup and leak a temporary tree into /tmp on every red run.
afterEach(cleanup);

const target = testTarget;

const supabaseTarget = (): ResolvedTarget =>
  testTarget({
    compute: {
      enabled: true,
      profile: 'encode',
      jobsWorkerName: 'starter-jobs-staging',
      mediaBucketName: 'starter-media-staging',
      encodeWorkflowName: 'encode-staging',
      maintenanceWorkflowName: 'maintenance-staging',
      containerImage: 'image@sha256:abc',
      imageProtocol: 'sample-v1',
      containerProfile: 'basic',
    },
    requiredSecretNames: [
      'SUPABASE_SERVICE_ROLE_KEY',
      'RESEND_API_KEY',
      'GOOGLE_DISPATCHER_CREDENTIAL',
    ],
  });

const encodeTarget = testTarget({
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
  requiredSecretNames: [
    'SUPABASE_SERVICE_ROLE_KEY',
    'RESEND_API_KEY',
    'GOOGLE_DISPATCHER_CREDENTIAL',
  ],
});

const tree = (withFixture: boolean): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-provision-'));
  created.push(root);
  if (withFixture) {
    const dir = join(root, 'apps/backend/media/fixtures/media');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sample-v1.mp4'), 'not really an mp4');
  }
  return root;
};

test('provisioning uploads the fixture where the runtime reads it', () => {
  const step = fixtureUploadStep(encodeTarget);
  expect(step?.source).toBe('apps/backend/media/fixtures/media/sample-v1.mp4');
  expect(FIXTURE_KEY).toBe(mediaFixtureKey(PROCESSOR_FIXTURE_ID));
  expect(step?.argv).toContain(`starter-media-staging/${mediaFixtureKey(PROCESSOR_FIXTURE_ID)}`);
});

describe('a secret never reaches argv', () => {
  test('a value-shaped argument is refused by name', () => {
    expect(secretInArgvProblem(['secret', 'put', 'SUPABASE_SERVICE_ROLE_KEY'])).toBeNull();
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
    expect(plan.map((entry) => entry.name)).toEqual([
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'RESEND_API_KEY',
      'GOOGLE_DISPATCHER_CREDENTIAL',
    ]);
    for (const entry of plan) {
      expect(Object.keys(entry).sort()).toEqual(['argv', 'envVar', 'name', 'source', 'workerName']);
      expect(JSON.stringify(entry)).not.toContain('hunter2');
    }
  });

  test('Supabase secrets are routed to the exact Workers and missing prerequisites stop before spawn', () => {
    const supabase = supabaseTarget();
    const plan = secretPlan(supabase, 'env');
    expect(plan.map(({ name, workerName }) => [name, workerName])).toEqual([
      ['SUPABASE_SERVICE_ROLE_KEY', 'starter-staging'],
      ['SUPABASE_SERVICE_ROLE_KEY', 'starter-jobs-staging'],
      ['RESEND_API_KEY', 'starter-staging'],
      ['GOOGLE_DISPATCHER_CREDENTIAL', 'starter-jobs-staging'],
    ]);
    const calls: string[][] = [];
    const result = provision(supabase, {
      root: tree(true),
      mode: 'secrets',
      installSecrets: true,
      env: { RESEND_API_KEY: 'mail-key', GOOGLE_DISPATCHER_CREDENTIAL: 'dispatcher-key' },
      run: (args) => {
        calls.push([...args]);
        return { ok: true, detail: 'unexpected' };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('secret:SUPABASE_SERVICE_ROLE_KEY');
    expect(calls).toHaveLength(0);
  });

  test('the secret plan targets the config of the root it was resolved against', () => {
    // The rest of the provisioner resolves every path against `root`. A secret
    // plan that quietly used the repository default would install against a config
    // file that does not exist — after the database, the bucket and the fixture had
    // already been created.
    const root = tree(true);
    const [first] = secretPlan(encodeTarget, 'env', root);

    const config = first?.argv[first.argv.indexOf('--config') + 1];
    expect(config).toBe(join(root, '.starter/deploy/staging-web.json'));
    expect(config).not.toContain(REPO_ROOT);
  });

  test('the secret plan still defaults to the repository root when given none', () => {
    const [first] = secretPlan(encodeTarget, 'env');
    const config = first?.argv[first.argv.indexOf('--config') + 1];

    expect(config).toBe(remoteConfigPath({ target: encodeTarget }));
  });

  test('installation passes the value on stdin and the name in argv', () => {
    const seen: { args: readonly string[]; stdin?: string }[] = [];
    provision(encodeTarget, {
      root: tree(true),
      mode: 'secrets',
      env: {
        SUPABASE_SERVICE_ROLE_KEY: 'super-secret-value',
        RESEND_API_KEY: 're_realvalue',
        GOOGLE_DISPATCHER_CREDENTIAL: 'dispatcher-secret',
      },
      installSecrets: true,
      run: (args, options) => {
        seen.push({ args: [...args], stdin: options.stdin });
        return { ok: true, detail: 'ok' };
      },
    });

    const installs = seen.filter((call) => call.args[0] === 'secret');
    expect(installs).toHaveLength(4);

    // The exact payloads, in order, including the trailing newline `wrangler` needs to
    // stop reading. Asserting "stdin is defined" would pass on any value at all,
    // including an empty string and another secret's value.
    expect(installs.map((call) => call.stdin)).toEqual([
      'super-secret-value\n',
      'super-secret-value\n',
      're_realvalue\n',
      'dispatcher-secret\n',
    ]);
    // Order matters: the names are in `RUNTIME_SECRET_NAMES` order.
    expect(installs.map((call) => call.args[2])).toEqual([
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'RESEND_API_KEY',
      'GOOGLE_DISPATCHER_CREDENTIAL',
    ]);

    for (const call of installs) {
      expect(call.args.join(' ')).not.toContain('super-secret-value');
      expect(call.args.join(' ')).not.toContain('re_realvalue');
    }
    expect(seen.map((call) => call.args.join(' ')).join('\n')).not.toContain('super-secret-value');
  });

  test("one secret's value never reaches another secret's stdin", () => {
    // A swapped or concatenated payload is invisible to "the value was not in argv".
    const seen: string[] = [];
    provision(encodeTarget, {
      root: tree(true),
      mode: 'secrets',
      env: {
        SUPABASE_SERVICE_ROLE_KEY: 'first-value',
        RESEND_API_KEY: 'second-value',
        GOOGLE_DISPATCHER_CREDENTIAL: 'third-value',
      },
      installSecrets: true,
      run: (args, options) => {
        if (args[0] === 'secret') {
          seen.push(options.stdin ?? '');
        }
        return { ok: true, detail: 'ok' };
      },
    });

    expect(seen).toEqual(['first-value\n', 'first-value\n', 'second-value\n', 'third-value\n']);
    expect(seen[0]).toBe('first-value\n');
    expect(seen[1]).toBe('first-value\n');
    expect(seen[2]).not.toContain('first-value');
    expect(seen[3]).not.toContain('first-value');
    expect(seen[3]).not.toContain('second-value');
  });

  test('a rendered report cannot contain a value, because no step holds one', () => {
    const result = provision(encodeTarget, {
      root: tree(true),
      mode: 'secrets',
      env: {
        SUPABASE_SERVICE_ROLE_KEY: 'super-secret-value',
        RESEND_API_KEY: 're_realvalue',
        GOOGLE_DISPATCHER_CREDENTIAL: 'dispatcher-secret',
      },
      installSecrets: true,
      run: () => ({ ok: true, detail: 'ok' }),
    });

    const rendered = renderProvision(result);
    expect(rendered).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(rendered).not.toContain('super-secret-value');
    expect(rendered).not.toContain('re_realvalue');
  });
});

describe('the Cloudflare token is not a runtime secret', () => {
  test('a missing runtime secret is named, and the deployment credential is not offered as a substitute', () => {
    const runs: string[][] = [];
    const result = provision(encodeTarget, {
      root: tree(true),
      mode: 'secrets',
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
    expect(result.stoppedAt).toBe('secret:SUPABASE_SERVICE_ROLE_KEY');
    const detail =
      result.steps.find((step) => step.name === 'secret:SUPABASE_SERVICE_ROLE_KEY')?.detail ?? '';
    expect(detail).toContain('CLOUDFLARE_API_TOKEN authorises this tooling');
    expect(detail).toContain('not the runtime secret');
  });
});

describe('provisioning is idempotent', () => {
  test('an existing bucket is reported as already, and nothing is created', () => {
    const created_: string[] = [];
    const result = provision(encodeTarget, {
      root: tree(true),
      capture: () => ({
        ok: true,
        stdout: JSON.stringify([{ name: 'starter-media-staging' }]),
        stderr: '',
      }),
      env: {},
      run: (args) => {
        created_.push(args.join(' '));
        return { ok: true, detail: 'ok' };
      },
    });

    const bucket = result.steps.find((step) => step.name === 'bucket');
    expect(bucket?.outcome).toBe('already');
    // The only remaining call is the fixture upload, which overwrites identical
    // bytes and is therefore safe to repeat.
    expect(created_.every((line) => line.startsWith('r2 object put'))).toBe(true);
  });

  test('an unreadable resource is never treated as absent', () => {
    // The control for the duplicate-resource bug. A revoked token, a network blip or
    // the wrong account all answer `!ok`; treating that as "absent" created a second
    // database or bucket under a name that already existed.
    const attempted: string[][] = [];
    const result = provision(encodeTarget, {
      root: tree(true),
      capture: () => ({ ok: false, stdout: '', stderr: 'authentication error' }),
      env: {},
      run: (args) => {
        attempted.push([...args]);
        return { ok: true, detail: 'ok' };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('bucket');
    // The configured bucket could not be read, so it was not created.
    expect(attempted).toEqual([]);
  });

  test('a bucket that cannot be listed is not created either', () => {
    const attempted: string[][] = [];
    const result = provision(encodeTarget, {
      root: tree(true),
      capture: () => ({ ok: false, stdout: '', stderr: 'bucket list refused' }),
      env: {},
      run: (args) => {
        attempted.push([...args]);
        return { ok: true, detail: 'ok' };
      },
    });

    expect(result.stoppedAt).toBe('bucket');
    expect(attempted).toEqual([]);
  });

  test('a bucket the successful read does not find is created', () => {
    // The distinction the two tests above make: an empty *successful* list means
    // absent, and absent is the only thing that may create.
    const attempted: string[][] = [];
    const result = provision(encodeTarget, {
      root: tree(true),
      capture: () => ({ ok: true, stdout: '[]', stderr: '' }),
      env: {},
      run: (args) => {
        attempted.push([...args]);
        return { ok: true, detail: 'ok' };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.stoppedAt).toBeNull();
    expect(attempted.some((args) => args[0] === 'r2' && args[1] === 'bucket')).toBe(true);
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

  test('a web-only target has no Cloud Run resources to provision', () => {
    const result = provision(target(), {
      root: tree(false),
      capture: () => ({ ok: true, stdout: '[]', stderr: '' }),
      env: {},
      run: () => ({ ok: true, detail: 'ok' }),
    });

    expect(result.steps.map((step) => step.name)).toEqual([
      'secret:SUPABASE_SERVICE_ROLE_KEY',
      'secret:RESEND_API_KEY',
    ]);
  });
});

describe('the fixture upload is refused when the fixture was never built', () => {
  test('the remedy names the command that generates it', () => {
    const result = provision(encodeTarget, {
      root: tree(false),
      capture: () => ({
        ok: true,
        stdout: JSON.stringify([{ name: 'starter-media-staging' }]),
        stderr: '',
      }),
      env: {},
      run: () => ({ ok: true, detail: 'ok' }),
    });

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('fixture');
    const fixture = result.steps.find((step) => step.name === 'fixture');
    expect(fixture?.detail).toContain('bun run --cwd apps/backend/media fixture');
    expect(fixture?.detail).toContain('Nothing was uploaded');
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
    expect(describeTokenScopes()).toContain('R2: Edit');
    expect(describeTokenScopes()).not.toContain('D1: Edit');
  });

  test('the resource step lists its exact R2 bucket before creating', () => {
    const bucket = provisionSteps(encodeTarget).find((step) => step.name === 'bucket');
    expect(bucket?.exists).toEqual(['r2', 'bucket', 'list', '--json']);
    expect(bucket?.present(JSON.stringify([{ name: 'starter-media-staging' }]))).toBe(true);
    expect(bucket?.present('not json')).toBe(false);
  });

  test('the resource steps name the same resources the target resolves', () => {
    const names = provisionSteps(encodeTarget).map((step) => step.name);
    expect(names).toEqual(['bucket']);
    expect(provisionSteps(target())).toEqual([]);
  });
});

describe('the provision and secrets halves are separate authority', () => {
  test('`deploy secrets` installs secrets and creates no resources', () => {
    // An operator refreshing one runtime secret must not also create a database, a
    // bucket and upload the fixture.
    const attempted: string[][] = [];
    const result = provision(encodeTarget, {
      root: tree(true),
      mode: 'secrets',
      capture: () => ({ ok: true, stdout: '[]', stderr: '' }),
      env: {
        SUPABASE_SERVICE_ROLE_KEY: 'super-secret-value',
        RESEND_API_KEY: 're_realvalue',
        GOOGLE_DISPATCHER_CREDENTIAL: 'dispatcher-secret',
      },
      installSecrets: true,
      run: (args) => {
        attempted.push([...args]);
        return { ok: true, detail: 'ok' };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.name)).toEqual([
      'secret:SUPABASE_SERVICE_ROLE_KEY',
      'secret:SUPABASE_SERVICE_ROLE_KEY',
      'secret:RESEND_API_KEY',
      'secret:GOOGLE_DISPATCHER_CREDENTIAL',
    ]);
    expect(attempted.every((args) => args[0] === 'secret')).toBe(true);
  });

  test('`deploy provision` without --install creates resources and says the secrets are absent', () => {
    const result = provision(encodeTarget, {
      root: tree(true),
      mode: 'resources',
      capture: () => ({
        ok: true,
        stdout: JSON.stringify([{ name: 'starter-media-staging' }]),
        stderr: '',
      }),
      env: {},
      run: () => ({ ok: true, detail: 'ok' }),
    });

    expect(result.ok).toBe(true);
    const secrets = result.steps.find((step) => step.name === 'secrets');
    expect(secrets?.outcome).toBe('skipped');
    expect(secrets?.detail).toContain('--yes --install');
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
      mode: 'secrets',
      secretSource: 'sops',
      run: () => ({ ok: true, detail: 'ok' }),
    });

    expect(result.ok).toBe(false);
    const detail = result.steps.find((step) => step.name === 'secrets')?.detail ?? '';
    expect(detail).toContain('bun run secrets:exec');
    expect(detail).toContain('Nothing was installed');
  });
});
