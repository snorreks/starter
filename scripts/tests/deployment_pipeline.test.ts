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

import { describe, expect, test } from 'bun:test';
import { runWrangler, setProcessRunner } from '../src/cloudflare/wrangler.ts';
import { type ApplyResult, apply, HEALTH_PATH, renderApply, smoke } from '../src/deploy/apply.ts';
import { type PreflightFinding, preflight } from '../src/deploy/preflight.ts';
import type { ArtifactCheck } from '../src/deploy/release.ts';
import type { ResolvedTarget } from '../src/deploy/target.ts';

const ACCOUNT = 'abcdef0123456789abcdef0123456789';
const OTHER_ACCOUNT = '99999999999999999999999999999999';

const target = (overrides: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  environment: 'staging',
  project: 'starter',
  accountId: ACCOUNT,
  workerName: 'starter-staging',
  d1DatabaseId: 'db-staging',
  origin: 'https://starter-staging.example',
  wranglerConfig: 'apps/frontend/client/wrangler.jsonc',
  requiredSecretNames: ['BETTER_AUTH_SECRET', 'RESEND_API_KEY'],
  requiredVarNames: ['DEPLOYMENT_ENV', 'BETTER_AUTH_URL', 'MAIL_FROM', 'RELEASE'],
  ...overrides,
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

/** A `fetch` that records the URLs requested and answers with a fixed response. */
const httpRecorder = (
  respond: (url: string) => { status?: number; body?: unknown; throws?: Error } = () => ({}),
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

/** `/health` answering correctly, which is the success case for verification. */
const healthy = (url: string) =>
  url.endsWith(HEALTH_PATH)
    ? { body: { status: 'ok', release: 'abc123', environment: 'staging', deployed: true } }
    : { status: 404, body: { error: 'not_found', message: 'No such route.' } };

describe('the apply pipeline spawns exactly the commands it prints', () => {
  test('migrations are applied to the named database before the deploy', async () => {
    const spawns = recorder();
    const http = httpRecorder(healthy);

    const result = await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: http.fetch,
      capture: () => ({ ok: true, stdout: '{"id":"dep-1","version_id":"v1"}', stderr: '' }),
      now: () => '2026-01-01T00:00:00.000Z',
      root: mkTempRoot(),
    });

    expect(result.ok).toBe(true);
    expect(spawns.calls).toHaveLength(2);

    // The migration names the environment and the binding, before anything deploys.
    const [migration, deploy] = spawns.calls;
    expect(migration?.args.slice(0, 4)).toEqual(['d1', 'migrations', 'apply', 'DB']);
    expect(migration?.args).toContain('--env');
    expect(migration?.args).toContain('staging');

    expect(deploy?.args.slice(0, 2)).toEqual(['deploy', '--env']);
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
      root: mkTempRoot(),
    });

    const deploy = spawns.calls[1];
    const meta = deploy?.args[deploy.args.indexOf('--meta') + 1] ?? '';
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
      root: mkTempRoot(),
    });

    expect(http.requests).toEqual(['https://starter-production.example/health']);
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
      root: mkTempRoot(),
    });
    await apply({
      target: target({
        environment: 'production',
        workerName: 'starter-production',
        d1DatabaseId: 'db-production',
        origin: 'https://starter.example',
      }),
      consented: true,
      inspect: () => artifact(),
      run: prod.run,
      fetch: httpRecorder(healthy).fetch,
      capture: () => ({ ok: false, stdout: '', stderr: '' }),
      root: mkTempRoot(),
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
      root: mkTempRoot(),
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
      root: mkTempRoot(),
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
      root: mkTempRoot(),
    });

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('validate');
    expect(spawns.calls).toEqual([]);
    expect(result.record).toBeNull();
  });

  test('a failed migration does not deploy', async () => {
    const spawns = recorder((args) => (args[0] === 'd1' ? 1 : 0));
    const result = await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: httpRecorder(healthy).fetch,
      root: mkTempRoot(),
    });

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('migrate');
    expect(spawns.calls).toHaveLength(1);
    expect(spawns.calls[0]?.args[0]).toBe('d1');
  });

  test('a migration failure says the schema may be partly applied and that a retry is safe', async () => {
    // Resume is a claim that has to be made while writing the message, because the
    // person reading it is deciding whether to re-run the command.
    const spawns = recorder((args) => (args[0] === 'd1' ? 1 : 0));
    const result = await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: httpRecorder(healthy).fetch,
      root: mkTempRoot(),
    });

    const migrate = result.outcomes.find((outcome) => outcome.phase === 'migrate');
    expect(migrate?.detail).toContain('partly applied');
    expect(migrate?.detail).toContain('re-running `apply` is safe');
  });

  test('a failed deploy still ran the migration, and says a rollback is not one', async () => {
    // The state that matters: schema applied, code not deployed. A rollback of the
    // code does not roll back the schema, and the message has to say so.
    const spawns = recorder((args) => (args[0] === 'd1' ? 0 : 1));
    const result = await apply({
      target: target(),
      consented: true,
      inspect: () => artifact(),
      run: spawns.run,
      fetch: httpRecorder(healthy).fetch,
      root: mkTempRoot(),
    });

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('deploy');
    expect(spawns.calls).toHaveLength(2);

    const deploy = result.outcomes.find((outcome) => outcome.phase === 'deploy');
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
      capture: () => ({ ok: true, stdout: '{"id":"dep-9","version_id":"v9"}', stderr: '' }),
      root: mkTempRoot(),
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
      root: mkTempRoot(),
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
      root: mkTempRoot(),
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
const remedyOf = (finding: PreflightFinding | undefined): string =>
  finding !== undefined && !finding.ok ? finding.remedy : '';

describe('preflight is read-only and refuses a mismatched destination', () => {
  const whoami = (account: string) => (args: readonly string[]) => {
    if (args[0] === 'whoami') {
      return { ok: true, stdout: `Account: ${account}\n`, stderr: '' };
    }
    if (args[0] === 'd1') {
      return { ok: true, stdout: `{"uuid":"db-staging","account_id":"${account}"}`, stderr: '' };
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

    for (const args of seen) {
      expect(['whoami', 'd1', 'deployments']).toContain(args[0]);
    }
    expect(seen.map((args) => args[0])).toEqual(['whoami', 'd1', 'deployments']);
    expect(seen[2]).toContain('deployments');
    expect(seen[2]).toContain('list');
  });

  test('a matching account and resources pass', () => {
    const report = preflight(target(), {
      env: { CLOUDFLARE_API_TOKEN: 't' },
      run: whoami(ACCOUNT),
    });
    expect(report.ok).toBe(true);
    expect(report.findings.filter((finding) => finding.ok)).toHaveLength(1);
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
      run: (args) =>
        args[0] === 'whoami'
          ? { ok: true, stdout: `${OTHER_ACCOUNT}\n${ACCOUNT}\n`, stderr: '' }
          : { ok: true, stdout: `{"account_id":"${ACCOUNT}"}`, stderr: '' },
    });

    expect(report.ok).toBe(true);
  });

  test('an unreadable database is refused with the remedy that creates it', () => {
    const report = preflight(target(), {
      env: { CLOUDFLARE_API_TOKEN: 't' },
      run: (args) => {
        if (args[0] === 'whoami') {
          return { ok: true, stdout: ACCOUNT, stderr: '' };
        }
        return { ok: false, stdout: '', stderr: 'not found' };
      },
    });

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.check).toBe('database');
    expect(remedyOf(report.findings[0])).toContain('--env staging --provision');
  });

  test('a database that belongs to another account is refused even though it exists', () => {
    // Exit code alone is not the check: `d1 info` answers happily for a database in
    // another account if the token can see it.
    const report = preflight(target(), {
      env: { CLOUDFLARE_API_TOKEN: 't' },
      run: (args) =>
        args[0] === 'whoami'
          ? { ok: true, stdout: ACCOUNT, stderr: '' }
          : { ok: true, stdout: `{"account_id":"${OTHER_ACCOUNT}"}`, stderr: '' },
    });

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.detail).toContain(`not ${ACCOUNT}`);
  });

  test('a missing Worker is a first-deploy fact only when the operator says so', () => {
    const failing = (args: readonly string[]) =>
      args[0] === 'whoami' || args[0] === 'd1'
        ? { ok: true, stdout: ACCOUNT, stderr: '' }
        : { ok: false, stdout: '', stderr: 'no such worker' };

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

/** A throwaway root, so a test never writes a release record into the repository. */
function mkTempRoot(): string {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  return mkdtempSync(join(tmpdir(), 'starter-release-'));
}
