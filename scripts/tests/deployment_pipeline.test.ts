// scripts/tests/deployment_pipeline.test.ts
//
// What the deployment actually spawns, and what it does when a step fails.
//
// These are written against the *effects*, not the return values. Every case drives
// `apply` with a recording process runner and a recording `fetch`, then asserts on
// the argv and the HTTP requests that were produced. A helper that returned the
// right object while spawning nothing would pass a return-value test and fail here,
// which is exactly the class of bug that shipped: `e2e:test` used to resolve to an
// `echo` and the suite was green.
//
// The failures covered are the ones an operator actually meets: a missing build, a
// migration that fails after the schema is half-applied, a deploy that fails after
// the migration succeeded, and a release that deploys but does not verify. The last
// two are the ones a "did it work?" test cannot construct, which is why resume is
// asserted explicitly.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runWrangler, setProcessRunner } from '../src/cloudflare/wrangler.ts';
import {
  type ApplyResult,
  apply as applyDeployment,
  HEALTH_PATH,
  renderApply,
  smoke,
} from '../src/deploy/apply.ts';
import { type PreflightFinding, preflight, secretListArgv } from '../src/deploy/preflight.ts';
import { supabaseMigrationArgs } from '../src/deploy/providers/supabase.ts';
import type { ArtifactCheck } from '../src/deploy/release.ts';
import { testTarget } from './fixtures/deployment_target.ts';

/**
 * The readiness URL, as a literal.
 *
 * The contract is the endpoint the deployed Worker answers, not whatever constant
 * the pipeline happens to use — so this is spelled here, and the test fails if the
 * pipeline stops asking for it rather than if it stops exporting a name.
 */
const READINESS_PATH = '/health/ready';

/**
 * The SHA the pipeline will build and publish.
 *
 * Pinned through the environment because verification now compares the release
 * the origin reports against the one this run published: a temp directory has no
 * `.git`, and a test that let the revision come out as `unknown` would not be
 * able to tell a matching release from a mismatched one.
 */
const SOURCE_SHA = 'a'.repeat(40);
const ORIGINAL_SOURCE_REVISION = process.env.SOURCE_REVISION;
process.env.SOURCE_REVISION = SOURCE_SHA;
afterAll(() => {
  if (ORIGINAL_SOURCE_REVISION === undefined) {
    delete process.env.SOURCE_REVISION;
  } else {
    process.env.SOURCE_REVISION = ORIGINAL_SOURCE_REVISION;
  }
});

const ACCOUNT = 'abcdef0123456789abcdef0123456789';
const OTHER_ACCOUNT = '99999999999999999999999999999999';
const target = testTarget;

const apply = (options: Parameters<typeof applyDeployment>[0]): Promise<ApplyResult> =>
  applyDeployment({
    ...options,
    configureSupabaseAuth: options.configureSupabaseAuth ?? (() => Promise.resolve()),
    migrateSupabase:
      options.migrateSupabase ??
      ((resolved) => ({
        code:
          options.run?.('supabase', supabaseMigrationArgs(resolved, 'push'), {
            cwd: 'packages/backend/database',
          }) ?? 0,
        stderr: '',
      })),
  });

const artifact = (overrides: Partial<ArtifactCheck> = {}): ArtifactCheck => ({
  ok: true,
  digest: 'sha256:deadbeef',
  fileCount: 42,
  problems: [],
  ...overrides,
});

/** Records every argv the pipeline spawns, and answers with a scripted exit code. */
interface Spawns {
  calls: { command: string; args: string[] }[];
  run: (command: string, args: readonly string[], options: { cwd: string }) => number;
}

const recorder = (exitFor: (args: string[]) => number = () => 0): Spawns => {
  const calls: { command: string; args: string[] }[] = [];
  return {
    calls,
    run: (command, args) => {
      calls.push({ command, args: [...args] });
      return exitFor([...args]);
    },
  };
};

/** What a scripted origin answers with: a status, a body, or a transport failure. */
interface ScriptedResponse {
  status?: number;
  body?: unknown;
  throws?: Error;
}

/** A `fetch` that records the URLs requested and answers with a fixed response. */
const httpRecorder = (
  respond: (url: string) => ScriptedResponse = () => ({}),
): {
  requests: string[];
  fetch: typeof globalThis.fetch;
} => {
  const requests: string[] = [];
  // `unknown` first: a bare arrow is not structurally a `typeof fetch` (which
  // carries `preconnect`), and the cast that made it one would have hidden a
  // genuine signature mismatch.
  const impl = (async (input: unknown): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    requests.push(url);
    const outcome = respond(url);
    if (outcome.throws !== undefined) {
      throw outcome.throws;
    }
    return new Response(JSON.stringify(outcome.body ?? { status: 'ok', release: 'abc123' }), {
      status: outcome.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  return { requests, fetch: impl };
};

/**
 * A release answering both probes correctly — the success case for verification.
 *
 * `/health/ready` is here because a Worker that is alive but whose Supabase connection is
 * unusable is the exact release this pipeline exists to catch, and the fixture has
 * to model it for the success case to mean anything.
 */
const healthy = (url: string): ScriptedResponse => {
  if (url.endsWith(HEALTH_PATH)) {
    return {
      body: { status: 'ok', release: SOURCE_SHA, environment: 'staging', deployed: true },
    };
  }
  if (url.endsWith(READINESS_PATH)) {
    return {
      body: {
        ok: true,
        release: { status: 'ok', release: SOURCE_SHA, environment: 'staging', deployed: true },
        checks: [{ binding: 'SUPABASE', ok: true, detail: 'answered a trivial query' }],
      },
    };
  }
  return { status: 404, body: { error: 'not_found', message: 'No such route.' } };
};

/** Alive and correctly identified, but its database is not ready. */
const aliveButNotReady = (url: string): ScriptedResponse =>
  url.endsWith(READINESS_PATH)
    ? {
        status: 503,
        body: {
          ok: false,
          release: { status: 'ok', release: SOURCE_SHA, environment: 'staging', deployed: true },
          checks: [{ binding: 'SUPABASE', ok: false, detail: 'database unavailable' }],
        },
      }
    : healthy(url);

describe('the apply pipeline spawns exactly the commands it prints', () => {
  test('Supabase migrations are applied to the named project before the deploy', async () => {
    const spawns = recorder();
    const http = httpRecorder(healthy);

    const result = await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: http.fetch,
      capture: () => ({
        ok: true,
        stdout:
          '[{"id":"older","created_on":"2025-12-31T00:00:00Z","versions":[{"version_id":"old-version","percentage":100}]},{"id":"dep-1","created_on":"2026-01-01T00:00:00Z","versions":[{"version_id":"v1","percentage":100}]}]',
        stderr: '',
      }),
      now: () => '2026-01-01T00:00:00.000Z',
      root: fixtureRoot(),
    });

    expect(result.ok).toBe(true);
    expect(result.record?.deploymentId).toBe('dep-1');
    expect(result.record?.versionId).toBe('v1');
    expect(spawns.calls).toHaveLength(2);

    // The migration names the resolved project before anything deploys.
    const [migration, deploy] = spawns.calls;
    expect(migration?.args).toContain('db');
    expect(migration?.args).toContain('push');
    expect(migration?.args).toContain('--project-ref');
    expect(migration?.args).toContain('stageprojectref00001');

    expect(deploy?.args.slice(0, 2)).toEqual(['deploy', '--name']);
    expect(deploy?.args).toContain('starter-staging');

    // The rendered argv is the spawned argv. Asserting only on return values would
    // not catch a divergence between what a reviewer reads and what runs.
    expect(result.argv).toEqual(spawns.calls.map((call) => call.args));
  });

  test('the deploy carries the release SHA and the artifact digest', async () => {
    // Provenance is the reason `--meta` exists: the recorded artifact has to be
    // independently checkable against what the provider stored.
    const spawns = recorder();
    const http = httpRecorder(healthy);

    await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: http.fetch,
      capture: () => ({ ok: false, stdout: '', stderr: '' }),
      root: fixtureRoot(),
    });

    const deploy = spawns.calls[1];
    const meta = deploy?.args[deploy.args.indexOf('--message') + 1] ?? '';
    expect(meta).toContain('artifact=sha256:deadbeef');
    expect(meta).toContain('source_sha=');
  });

  test('verification fetches the release origin, not a hard-coded host', async () => {
    const spawns = recorder();
    const http = httpRecorder(healthy);

    await apply({
      target: target({ origin: 'https://starter-production.example' }),
      consented: true,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: http.fetch,
      capture: () => ({ ok: false, stdout: '', stderr: '' }),
      root: fixtureRoot(),
    });

    // Both probes, against the resolved target. Readiness is the one that decides
    // whether the release can actually serve.
    expect(http.requests).toEqual([
      'https://starter-production.example/health',
      'https://starter-production.example/health/ready',
    ]);
  });

  test('staging and production spawn different deployments', async () => {
    // The property that makes `--env` mean anything: two runs, two destinations.
    const stage = recorder();
    const prod = recorder();

    await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: stage.run,
      fetch: httpRecorder(healthy).fetch,
      capture: () => ({ ok: false, stdout: '', stderr: '' }),
      root: fixtureRoot(),
    });
    await apply({
      target: target({
        environment: 'production',
        workerName: 'starter-production',
        origin: 'https://starter.example',
      }),
      consented: true,
      inspect: () => artifact(),
      run: prod.run,
      fetch: httpRecorder(healthy).fetch,
      capture: () => ({ ok: false, stdout: '', stderr: '' }),
      // The production fixture names the production database, or the agreement
      // check refuses before the deploy step this test is asserting on.
      root: fixtureRoot(),
    });

    expect(stage.calls[1]?.args).toContain('starter-staging');
    expect(prod.calls[1]?.args).toContain('starter-production');
    expect(stage.calls[1]?.args).not.toContain('db-production');
  });

  test('wrangler appears exactly once in the spawned argv', async () => {
    // The regression this repository has already had: a plan that included the
    // binary *and* used a runner that prepended it produced
    // `wrangler wrangler deploy`, which fails naming neither the plan nor the cause.
    const spawns = recorder();
    await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: httpRecorder(healthy).fetch,
      capture: () => ({ ok: false, stdout: '', stderr: '' }),
      root: fixtureRoot(),
    });

    for (const call of spawns.calls) {
      expect(call.args.filter((arg) => arg === 'wrangler')).toEqual([]);
    }
  });

  test('the runner resolves the pinned binary, not a global `wrangler`', () => {
    // Observed at the process boundary the CLI actually uses. The drift this
    // prevents is real: `bunx wrangler` from the repository root did not find the
    // workspace copy and downloaded whatever the registry served.
    const seen: { command: string; args: string[] }[] = [];
    setProcessRunner({
      run: (command, args) => {
        seen.push({ command, args: [...args] });
        return 0;
      },
    });

    try {
      runWrangler(['deploy', '--env', 'staging'], { cwd: '/tmp' });
    } finally {
      setProcessRunner(null);
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]?.args).toEqual(['deploy', '--env', 'staging']);
    expect(seen[0]?.command.endsWith('wrangler')).toBe(true);
    expect(seen[0]?.command).not.toContain('bunx');
  });
});

describe('apply refuses and stops at the first failing step', () => {
  test('without --yes nothing is spawned at all', async () => {
    const spawns = recorder();
    const result = await apply({
      target: target(),
      consented: false,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: httpRecorder(healthy).fetch,
      root: fixtureRoot(),
    });

    expect(result.ok).toBe(false);
    expect(spawns.calls).toEqual([]);
    expect(result.stoppedAt).toBe('build');
  });

  test('an absent artifact stops before the migration touches anything', async () => {
    // The dangerous ordering: migrating first and discovering there is no Worker
    // afterwards leaves the schema ahead of any code that can use it.
    const spawns = recorder();
    const result = await apply({
      target: target(),
      consented: true,
      inspect: () => ({
        ok: false,
        digest: null,
        fileCount: 0,
        problems: ['no _worker.js'],
      }),
      run: spawns.run,
      fetch: httpRecorder(healthy).fetch,
      root: fixtureRoot(),
    });

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('validate');
    expect(spawns.calls).toEqual([]);
    expect(result.record).toBeNull();
  });

  test('a failed migration does not deploy', async () => {
    const spawns = recorder((args) => (args[0] === 'db' ? 1 : 0));
    const result = await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: httpRecorder(healthy).fetch,
      root: fixtureRoot(),
    });

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('schema');
    expect(spawns.calls).toHaveLength(1);
    expect(spawns.calls[0]?.args[0]).toBe('db');
  });

  test('a migration failure says the schema may be partly applied and that a retry is safe', async () => {
    // Resume is a claim that has to be made while writing the message, because the
    // person reading it is deciding whether to re-run the command.
    const spawns = recorder((args) => (args[0] === 'db' ? 1 : 0));
    const result = await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: httpRecorder(healthy).fetch,
      root: fixtureRoot(),
    });

    const migrate = result.outcomes.find((outcome) => outcome.phase === 'schema');
    expect(migrate?.detail).toContain('partly applied');
    expect(migrate?.detail).toContain('re-running `apply` is safe');
  });

  test('a failed deploy still ran the migration, and says a rollback is not one', async () => {
    // The state that matters: schema applied, code not deployed. A rollback of the
    // code does not roll back the schema, and the message has to say so.
    const spawns = recorder((args) => (args[0] === 'db' ? 0 : 1));
    const result = await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: httpRecorder(healthy).fetch,
      root: fixtureRoot(),
    });

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('web');
    expect(spawns.calls).toHaveLength(2);

    const deploy = result.outcomes.find((outcome) => outcome.phase === 'web');
    expect(deploy?.detail).toContain('schema is ahead of the running code');
    expect(deploy?.detail).toContain('docs/deployment.md');
  });

  test('a failed verification is a failure, and the release is still recorded', async () => {
    // Not a warning. A deploy that succeeded and did not answer `/health` is the
    // situation in which the deployment id matters most — and not writing the
    // record would lose the one thing needed to roll it back.
    const spawns = recorder();
    const http = httpRecorder(() => ({ status: 500, body: { error: 'boom' } }));

    const result: ApplyResult = await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: http.fetch,
      capture: () => ({
        ok: true,
        stdout:
          '[{"id":"dep-9","created_on":"2026-01-01T00:00:00Z","versions":[{"version_id":"v9","percentage":100}]}]',
        stderr: '',
      }),
      root: fixtureRoot(),
    });

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('verify');
    expect(result.record).not.toBeNull();
    expect(result.record?.smoke?.ok).toBe(false);
    expect(result.record?.deploymentId).toBe('dep-9');
  });

  test('verification never keeps a response body in the record', async () => {
    // The record outlives the deployment and gets pasted into tickets. A body is
    // whatever the origin chose to return, and eventually that is user data.
    const spawns = recorder();
    const http = httpRecorder(() => ({
      status: 200,
      body: { status: 'ok', release: 'abc123', secretish: 'hunter2' },
    }));

    const result = await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: http.fetch,
      capture: () => ({ ok: false, stdout: '', stderr: '' }),
      root: fixtureRoot(),
    });

    expect(JSON.stringify(result.record)).not.toContain('hunter2');
  });

  test('a network failure during verification is reported, not swallowed', async () => {
    const result = await smoke(
      target(),
      httpRecorder(() => ({ throws: new Error('ECONNREFUSED') })).fetch,
    );

    expect(result.ok).toBe(false);
    expect(result.problem).toContain('Could not reach');
    expect(result.status).toBeNull();
  });

  test('an HTML error page from the origin is a failed verification', async () => {
    // A 200 that is not this application's health endpoint. A status-code-only check
    // calls this a successful deploy, which is how a broken release gets recorded as
    // released — the same class of defect as `not_found_handling: "404-page"`, where
    // a browser and `curl` disagreed about one response.
    const impl = (async (): Promise<Response> =>
      new Response('<!doctype html><title>Error</title>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof globalThis.fetch;

    const result = await smoke(target(), impl);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.reportedRelease).toBeNull();
    expect(result.problem).toContain('without identifying a release');
  });

  test('a JSON response that carries no release field is also a failure', async () => {
    // The proxy case: something answered on the hostname with JSON that is not ours.
    const result = await smoke(target(), httpRecorder(() => ({ body: { hello: 'world' } })).fetch);

    expect(result.ok).toBe(false);
    expect(result.problem).toContain('without identifying a release');
  });

  test('a refusal still says why, rather than only naming the phase', async () => {
    // `renderApply` tells the reader to look at the detail *above* the stop line, so
    // a refusal that pushes no outcome renders as a bare "Stopped at: build".
    const result = await apply({
      target: target(),
      consented: false,
      inspect: () => artifact(),
      run: recorder().run,
      fetch: httpRecorder(healthy).fetch,
      root: fixtureRoot(),
    });

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.ok).toBe(false);
    expect(renderApply(result)).toContain('--yes');
  });
});

/**
 * The remedy for a refusal, or `''` when the finding was a pass.
 *
 * Read through a narrowing helper rather than `finding.remedy`, because a union
 * with a success arm does not carry the field and `?.` on it is the kind of access
 * that silently stops asserting anything.
 */
/**
 * A read-only wrangler answer, chosen by which check is asking.
 *
 * A helper rather than a chain of ternaries inside each fixture: three fixtures grew
 * a third `secret` arm, and a nested ternary four deep is a place a fourth arm gets
 * forgotten — which is how a fixture that meant "everything passes" ends up answering
 * `'[]'` for secrets and silently testing a failing release.
 */
const answering =
  (
    byCommand: Record<string, { ok: boolean; stdout: string; stderr?: string }>,
    fallback: { ok: boolean; stdout: string; stderr?: string },
  ) =>
  (args: readonly string[]): { ok: boolean; stdout: string; stderr: string } => {
    const answer = byCommand[args[0] ?? ''] ?? fallback;
    return { ok: answer.ok, stdout: answer.stdout, stderr: answer.stderr ?? '' };
  };

/**
 * What `wrangler secret list --json` answers for a Worker that has both secrets.
 *
 * Named once because three fixtures need it, and a fixture that forgot the `secret`
 * arm used to read as "no secrets installed" — which, before the `ok` derivation fix,
 * still reported a passing preflight.
 */
const INSTALLED_SECRETS = JSON.stringify([
  { name: 'SUPABASE_SERVICE_ROLE_KEY' },
  { name: 'RESEND_API_KEY' },
]);

const remedyOf = (finding: PreflightFinding | undefined): string =>
  finding !== undefined && !finding.ok ? (finding.remedy ?? '') : '';

describe('preflight is read-only and refuses a mismatched destination', () => {
  const whoami = (account: string) => (args: readonly string[]) => {
    if (args[0] === 'whoami') {
      return { ok: true, stdout: `Account: ${account}\n`, stderr: '' };
    }
    if (args[0] === 'secret') {
      return { ok: true, stdout: INSTALLED_SECRETS, stderr: '' };
    }
    return { ok: true, stdout: '[]', stderr: '' };
  };

  test('every command it runs is read-only', () => {
    // Asserted on the command list itself so a future edit that makes a check
    // mutating fails here rather than becoming an action taken during a check.
    const seen: string[][] = [];
    preflight(target(), {
      env: { CLOUDFLARE_API_TOKEN: 't' },
      run: (args) => {
        seen.push([...args]);
        return { ok: true, stdout: `${ACCOUNT}`, stderr: '' };
      },
    });

    // Asserted on the command list itself so a future edit that makes a check
    // mutating fails here rather than becoming an action taken during a check.
    // `secret list` is here because the check that a release is able to confirm an
    // account is read-only too: it reports *names*, never values.
    for (const args of seen) {
      expect(['whoami', 'deployments', 'secret']).toContain(args[0]);
    }
    expect(seen.map((args) => args[0])).toEqual(['whoami', 'deployments', 'secret']);
    expect(seen[1]).toContain('deployments');
    expect(seen[1]).toContain('list');
    // The pinned CLI spells this `--format json`, and the scope is `--env`.
    // `--json` is not a flag wrangler 4.142.0 has on `secret list`, and asserting the
    // invented spelling here is what let it reach a real account.
    expect(seen[2]).toEqual(secretListArgv('starter-staging', 'staging'));
    expect(seen[2]).toEqual(['secret', 'list', '--name', 'starter-staging', '--format', 'json']);
  });

  test('a matching account and resources pass', () => {
    const report = preflight(target(), {
      env: { CLOUDFLARE_API_TOKEN: 't' },
      run: whoami(ACCOUNT),
    });
    expect(report.ok).toBe(true);
    // The worker, the secrets and the mail report. `mail` is a *warning*: a sender
    // is configured, but sender-domain verification is a fact about the mail
    // provider that no read-only Cloudflare call can establish.
    expect(report.findings.filter((finding) => finding.ok)).toHaveLength(3);
    expect(report.findings.find((finding) => finding.check === 'mail')?.warn).toBe(true);
  });

  test('a token for another account is refused before anything is touched', () => {
    // The failure that is otherwise only visible after a mutation: wrangler acts on
    // the account its token grants, whatever the plan said.
    const report = preflight(target(), {
      env: { CLOUDFLARE_API_TOKEN: 't' },
      run: whoami(OTHER_ACCOUNT),
    });

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.detail).toContain(OTHER_ACCOUNT);
    expect(report.findings[0]?.detail).toContain(ACCOUNT);
    expect(remedyOf(report.findings[0])).toContain('Nothing has been changed');
  });

  test('a token with access to several accounts is not resolved to the first match', () => {
    const report = preflight(target(), {
      env: { CLOUDFLARE_API_TOKEN: 't' },
      run: answering(
        {
          whoami: { ok: true, stdout: `${OTHER_ACCOUNT}\n${ACCOUNT}\n` },
          secret: { ok: true, stdout: INSTALLED_SECRETS },
        },
        { ok: true, stdout: `{"account_id":"${ACCOUNT}"}` },
      ),
    });

    expect(report.ok).toBe(true);
  });

  test('a missing Worker is a first-deploy fact only when the operator says so', () => {
    // `secret list` still answers on a Worker that has never been deployed, so this
    // fixture keeps the two apart: the Worker check fails, the secrets check does
    // not, which is exactly the state `--allow-new-worker` describes.
    const failing = answering(
      {
        whoami: { ok: true, stdout: ACCOUNT },
        secret: { ok: true, stdout: INSTALLED_SECRETS },
      },
      { ok: false, stdout: '', stderr: 'no such worker' },
    );

    const strict = preflight(target(), { env: { CLOUDFLARE_API_TOKEN: 't' }, run: failing });
    expect(strict.ok).toBe(false);
    expect(remedyOf(strict.findings[0])).toContain('--allow-new-worker');

    const first = preflight(target(), {
      env: { CLOUDFLARE_API_TOKEN: 't' },
      run: failing,
      allowMissingWorker: true,
    });
    expect(first.ok).toBe(true);
  });

  test('a release with no runtime secrets installed is refused, not reported as ok', () => {
    // The control for `ok` being derived from the findings. Before the fix this
    // returned `ok: true` with a failing `secrets` finding recorded, which is how a
    // deployment with no Supabase service key passed preflight.
    const withoutSecrets = preflight(target(), {
      env: { CLOUDFLARE_API_TOKEN: 't' },
      run: answering(
        {
          whoami: { ok: true, stdout: ACCOUNT },
          // One secret present, one absent: the state this control is about.
          secret: { ok: true, stdout: JSON.stringify([{ name: 'SUPABASE_SERVICE_ROLE_KEY' }]) },
        },
        { ok: true, stdout: ACCOUNT },
      ),
    });

    expect(withoutSecrets.ok).toBe(false);
    const secrets = withoutSecrets.findings.find((finding) => finding.check === 'secrets');
    expect(secrets?.ok).toBe(false);
    expect(secrets?.detail).toContain('RESEND_API_KEY');
    expect(remedyOf(secrets)).toContain('Nothing has been changed');
  });

  test('a check that passed but proved less does not fail the report', () => {
    // `warn` is not `ok: false`. The mail check says sender-domain verification was
    // NOT CHECKED; that must not stop an otherwise correct release, or every first
    // deploy would need a provider this tooling cannot query.
    const report = preflight(target(), {
      env: { CLOUDFLARE_API_TOKEN: 't' },
      run: whoami(ACCOUNT),
    });

    expect(report.ok).toBe(true);
    expect(report.findings.find((finding) => finding.check === 'mail')?.warn).toBe(true);
  });

  test('no credential is reported without spawning anything', () => {
    // Preflight is the first phase that needs a credential, so this is where the
    // refusal belongs — and it must happen before any network call.
    const spawned: string[][] = [];
    const report = preflight(target(), {
      env: {},
      run: (args) => {
        spawned.push([...args]);
        return { ok: true, stdout: '', stderr: '' };
      },
    });

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.check).toBe('credential');
    expect(spawned).toEqual([]);
    expect(report.findings[0]?.detail).toContain('CLOUDFLARE_API_TOKEN');
  });
});

/**
 * A throwaway root containing a `wrangler.jsonc` whose D1 id matches the target.
 *
 * The pipeline refuses when the id it resolved and the id Wrangler would reach
 * differ. Without this fixture every pipeline test would stop at the migration
 * step — correct behaviour, but it would test nothing else.
 */
const fixtureRoot = (): string => {
  const root = mkTempRoot();
  const path = join(root, 'apps/frontend/client/wrangler.jsonc');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `{\n  "name": "starter",\n  "main": ".svelte-kit/cloudflare/_worker.js",\n  "assets": { "directory": ".svelte-kit/cloudflare", "binding": "ASSETS" }\n}\n`,
    'utf8',
  );
  return root;
};

/** A throwaway root, so a test never writes a release record into the repository. */
function mkTempRoot(): string {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  return mkdtempSync(join(tmpdir(), 'starter-release-'));
}

// ── readiness ────────────────────────────────────────────────────────────────
//
// Liveness and readiness are different questions, and only one of them was being
// asked. `/health` reads configuration: nothing in it can fail on its own, so a
// release whose D1 binding points at a deleted database answered 200 with the right
// release id and was recorded as verified. These controls fix that case: 200 +
// 503 is a failed release record, not a warning.

describe('verification asks whether the release can serve, not only whether it is up', () => {
  test('readiness is fetched with its own bounded request', async () => {
    const result = await smoke(target(), httpRecorder(healthy).fetch);

    expect(result.ok).toBe(true);
    expect(result.readiness?.ok).toBe(true);
    expect(result.readiness?.status).toBe(200);
  });

  test('a healthy liveness with an unready database is a failed verification', async () => {
    const result = await smoke(target(), httpRecorder(aliveButNotReady).fetch);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.reportedRelease).toBe(SOURCE_SHA);
    expect(result.readiness?.ok).toBe(false);
    expect(result.readiness?.status).toBe(503);
    expect(result.path).toBe(READINESS_PATH);
    expect(result.problem).toContain(READINESS_PATH);
  });

  test('a readiness body that says ok:false is a failure even at 200', async () => {
    // A proxy or a future refactor that returns 200 with a failing report must not
    // be read as healthy: the payload is the contract, not just the status.
    const http = httpRecorder((url) =>
      url.endsWith(READINESS_PATH)
        ? { status: 200, body: { ok: false, checks: [{ binding: 'DB', ok: false }] } }
        : healthy(url),
    );

    const result = await smoke(target(), http.fetch);
    expect(result.ok).toBe(false);
    expect(result.readiness?.ok).toBe(false);
  });

  test('an unreachable readiness probe is reported rather than assumed healthy', async () => {
    const http = httpRecorder((url) =>
      url.endsWith(READINESS_PATH) ? { throws: new Error('socket hang up') } : healthy(url),
    );

    const result = await smoke(target(), http.fetch);
    expect(result.ok).toBe(false);
    expect(result.readiness?.ok).toBe(false);
    expect(result.problem).toContain(READINESS_PATH);
  });

  test('a probe that never answers is abandoned at the injected budget', async () => {
    // Injected, not slept through: an origin that accepts the connection and never
    // replies must not hold the deploy job open for the runner's own timeout.
    let observed: AbortSignal | undefined;
    const hanging = (async (input: unknown, init?: { signal?: AbortSignal }) => {
      if (!String(input).endsWith(READINESS_PATH)) {
        return httpRecorder(healthy).fetch(String(input));
      }
      observed = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('The operation was aborted.'));
        });
      });
    }) as unknown as typeof globalThis.fetch;

    const startedAt = Date.now();
    const result = await smoke(target(), hanging, { timeoutMs: 50 });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(result.path).toBe(READINESS_PATH);
    expect(observed).toBeDefined();
    // Generous upper bound, still an order of magnitude below the real timeout:
    // this asserts the budget is applied, not that the clock is fast.
    expect(elapsed).toBeLessThan(5_000);
  });

  test.each(['AbortError', 'TimeoutError'])(
    'a readiness body interrupted by %s reports a timeout',
    async (name) => {
      const interrupted = (async (input: unknown) => {
        if (!String(input).endsWith(READINESS_PATH)) {
          return httpRecorder(healthy).fetch(String(input));
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException('body interrupted', name));
            },
          }),
        );
      }) as typeof globalThis.fetch;

      const result = await smoke(target(), interrupted, { timeoutMs: 50 });
      expect(result.ok).toBe(false);
      expect(result.path).toBe(READINESS_PATH);
      expect(result.readiness?.status).toBe(200);
      expect(result.problem).toContain(`Timed out reading ${READINESS_PATH} after 50ms`);
    },
  );

  test('apply records a release whose readiness failed, and does not claim success', async () => {
    const spawns = recorder();
    const http = httpRecorder(aliveButNotReady);

    const result = await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: http.fetch,
      capture: () => ({
        ok: true,
        stdout:
          '[{"id":"dep-3","created_on":"2026-01-01T00:00:00Z","versions":[{"version_id":"v3","percentage":100}]}]',
        stderr: '',
      }),
      now: () => '2026-01-01T00:00:00.000Z',
      root: fixtureRoot(),
    });

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('verify');
    expect(result.record).not.toBeNull();
    expect(result.record?.smoke?.ok).toBe(false);
    expect(result.record?.smoke?.readiness?.ok).toBe(false);
    // The deployment id is exactly what a rollback needs, so it is kept.
    expect(result.record?.deploymentId).toBe('dep-3');
    expect(renderApply(result)).toContain(READINESS_PATH);
  });

  test('the readiness body never reaches the release record', async () => {
    const http = httpRecorder((url) =>
      url.endsWith(READINESS_PATH)
        ? {
            status: 503,
            body: {
              ok: false,
              detail: 'connection string postgres://user:hunter2@db',
              checks: [{ binding: 'DB', ok: false, detail: 'secretish' }],
            },
          }
        : healthy(url),
    );

    const result = await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: recorder().run,
      fetch: http.fetch,
      capture: () => ({ ok: false, stdout: '', stderr: '' }),
      root: fixtureRoot(),
    });

    expect(result.record?.smoke?.readiness?.status).toBe(503);
    expect(JSON.stringify(result.record)).not.toContain('hunter2');
    expect(JSON.stringify(result.record)).not.toContain('postgres://');
  });
});
