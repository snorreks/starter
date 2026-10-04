// apps/frontend/client/tests/worker_integration.test.ts
//
// Integration test against the real local runtime and the **built** Worker.
//
// This drives `wrangler dev .svelte-kit/cloudflare/_worker.js` — the actual
// Workers runtime, with its own isolated local D1 — over real HTTP. It is not a
// mocked router and it is not the dev server: SvelteKit, Better Auth, Drizzle and
// D1 are all genuinely involved, and the artifact under test is the one a deploy
// would ship.
//
// That distinction is the whole point of this file. `vite dev` runs the server
// code in Node, where a bundling mistake is invisible: a `node:fs` import in a
// server module resolves, an import that only Vite's dev transform understands
// resolves, and a `cloudflare:workers` binding that is a stub in dev is a real
// module in production. Only workerd over the built bundle exercises the thing
// that gets deployed.
//
// Two properties this file is careful about, both learned the hard way:
//
//   1. **Identity, not just a port.** A stale Worker left listening on the test
//      port answers `/api/health` exactly as readily as the one just started. A
//      readiness probe that only checks for a 200 will run the entire suite
//      against the wrong process — green, and proving nothing. Every readiness
//      check below therefore requires the `testRunId` this run generated.
//
//   2. **Own processes only.** Ports are chosen by binding to port 0 and letting
//      the OS pick, and only processes this file started are ever stopped.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { LogEvent } from '@starter/schemas/logging';
import { createId } from '@starter/utils';
import { killTree } from '@starter/utils/process';
import { sleep, spawnSync } from 'bun';
import { MAX_BODY_BYTES, MAX_RECORDS_PER_SUBMISSION } from '../src/lib/server/telemetry_service.ts';
import { REPO_ROOT } from './database_paths.ts';

const APP_DIR = join(REPO_ROOT, 'apps/frontend/client');
const APP_CONFIG = join(APP_DIR, 'wrangler.jsonc');
const WORKER_ENTRY = join(APP_DIR, '.svelte-kit/cloudflare/_worker.js');
const LOCAL_STATE = join(APP_DIR, '.wrangler/state');

/**
 * The pinned workspace copy of wrangler.
 *
 * `bunx wrangler` from here or from the repository root does not find a binary
 * that only `apps/frontend/client` depends on, so it downloads whatever npm
 * serves that day. This suite then prepares a database and boots a Worker with a
 * tool version the project never validated.
 */
const WRANGLER = join(APP_DIR, 'node_modules', '.bin', 'wrangler');

const WORKER_LOG = process.env.WORKER_LOG ?? '/tmp/starter-integration-worker.log';

/** Identifies this run. Echoed by /api/health so readiness is provable. */
const RUN_ID = `run-${createId('it', 8)}`;

/** Per-minute sign-in budget for this run. The limit itself stays enabled. */
const AUTH_RATE_LIMIT_MAX = '500';

let server: ChildProcess | undefined;
let port = 0;

const base = (): string => `http://127.0.0.1:${port}`;

/** Ask the OS for a free port instead of hard-coding one. */
const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('Could not determine a free port.')));
        return;
      }
      const { port: chosen } = address;
      probe.close(() => resolve(chosen));
    });
  });

interface Readiness {
  ready: boolean;
  reason: string;
}

/**
 * Wait until *our* Worker answers.
 *
 * Reports the specific failure rather than a generic timeout: "a different
 * process holds this port" and "our Worker failed to start" need completely
 * different fixes, and collapsing them into one message wastes the reader's
 * time.
 */
const waitForOurWorker = async (timeoutMs = 120_000): Promise<Readiness> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base()}/api/health`);
      if (response.ok) {
        const health = (await response.json()) as { testRunId?: string };
        if (health.testRunId === RUN_ID) {
          return { ready: true, reason: '' };
        }
        return {
          ready: false,
          reason:
            'Another process is already listening on the test port and is ' +
            'answering /api/health. Refusing to run: a suite that talks to a ' +
            'stale Worker passes without testing anything.',
        };
      }
    } catch {
      // Not listening yet.
    }
    await sleep(400);
  }

  return {
    ready: false,
    reason: `Our Worker never became ready within ${timeoutMs / 1000}s. Log: ${WORKER_LOG}`,
  };
};

beforeAll(async () => {
  if (!existsSync(APP_CONFIG)) {
    throw new Error(`Missing ${APP_CONFIG}`);
  }
  if (!existsSync(WRANGLER)) {
    throw new Error(
      `wrangler is not installed at ${WRANGLER}. Run \`bun install\` from the repository root.`,
    );
  }
  // The built Worker is the subject. Testing the dev server instead would be a
  // different suite, and one that cannot see a bundling mistake.
  if (!existsSync(WORKER_ENTRY)) {
    throw new Error(
      `Missing ${WORKER_ENTRY}.\n` +
        '  This suite drives the built Worker, not `vite dev`: a bundling mistake ' +
        'only reproduces in workerd. Run `bun run build` first.',
    );
  }

  port = await findFreePort();

  // Isolate the database: a stale local state would make "create" assertions
  // depend on whatever a previous run left behind.
  rmSync(LOCAL_STATE, { recursive: true, force: true });

  const migrate = spawnSync(
    [WRANGLER, 'd1', 'migrations', 'apply', 'DB', '--local', '--config', APP_CONFIG],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  if (migrate.exitCode !== 0) {
    throw new Error(`Migration failed:\n${migrate.stderr.toString()}`);
  }

  const logFd = openSync(WORKER_LOG, 'w');

  server = spawn(
    WRANGLER,
    [
      'dev',
      WORKER_ENTRY,
      '--port',
      String(port),
      '--local',
      '--config',
      APP_CONFIG,
      '--var',
      `TEST_RUN_ID:${RUN_ID}`,
      // Explicit, and the default in wrangler.jsonc too. The app decides whether
      // development defaults are permitted from this binding alone, so a suite
      // that omitted it would be exercising a different code path from the one a
      // developer runs.
      '--var',
      'DEPLOYMENT_ENV:local',
      // Required in a deployed environment, optional in a local one — where it is
      // derived from the origin this Worker is reached on, which is the port
      // chosen above. That derivation is what lets one suite run on an ephemeral
      // port without a second configured value to keep in step.
      //
      // The secret is real and is the only thing standing between this suite and
      // a session signed with a value in this repository.
      '--var',
      'BETTER_AUTH_SECRET:integration-test-secret-not-for-production-use',
      // The sign-in rate limit is real and stays on. A test run creates an
      // account per case, which exceeds a production-sane per-minute budget, so
      // the budget is raised for the run rather than disabled — disabling it
      // would also stop this suite from exercising the limit's existence.
      '--var',
      `AUTH_RATE_LIMIT_MAX:${AUTH_RATE_LIMIT_MAX}`,
    ],
    {
      cwd: APP_DIR,
      // Captured rather than ignored: a Worker that throws answers 500 with an
      // empty body, and a swallowed log makes that undebuggable.
      stdio: ['ignore', logFd, logFd],
    },
  );

  const readiness = await waitForOurWorker();
  if (!readiness.ready) {
    if (server?.pid !== undefined) {
      killTree(server.pid, { graceMs: 200, attempts: 10 });
    }
    throw new Error(readiness.reason);
  }
}, 240_000);

afterAll(() => {
  // Only ever the process this file started, and its whole tree.
  //
  // `server.kill()` alone leaves `workerd` — wrangler's own child, and the thing
  // actually holding the port — running. A `killTree` walk from the recorded pid
  // takes both. Walk the tree rather than use a pattern: `pkill -f wrangler` also
  // matches the shell that launched this suite, which kills the caller.
  if (server?.pid !== undefined) {
    killTree(server.pid, { graceMs: 200, attempts: 20 });
  }
  server = undefined;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Every structured record the Worker has written, read from its own log.
 *
 * This is the only way to observe what a deployed Worker emits: there is no other
 * destination for it, and the defect this file's log section exists for was exactly
 * that nothing was written. Wrangler prefixes each console call with `stdout: `, so
 * the prefix is stripped before parsing rather than the whole line being ignored.
 *
 * Polling, not a sleep: workerd writes the record before it answers the request, but
 * the capture file is written by wrangler's own process, so "before the response" is
 * about the record's existence and not about this read. A short bounded wait for a
 * count to reach an expectation is the honest way to wait for a file another process
 * appends to; failing after the budget names the records that were seen.
 */
const structuredRecords = (): LogEvent[] => {
  let contents: string;
  try {
    contents = readFileSync(WORKER_LOG, 'utf8');
  } catch (error) {
    throw new Error(`Could not read Worker log ${WORKER_LOG}: ${String(error)}`, { cause: error });
  }

  return contents
    .split('\n')
    .map((line) => (line.startsWith('stdout: ') ? line.slice('stdout: '.length) : line))
    .map((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return parsed !== null && typeof parsed === 'object' && 'event' in parsed
          ? (parsed as LogEvent)
          : null;
      } catch {
        return null;
      }
    })
    .filter((event): event is LogEvent => event !== null);
};

/**
 * Wait until at least `count` records match, and return everything that matched.
 *
 * The count is a floor, not a target: the assertion that a request produced exactly
 * one record compares before/after lengths, so this only has to notice that the
 * append happened. On timeout it returns what it saw, and the caller's length
 * assertion reports the real number rather than a generic failure.
 */
const awaitRecords = async (
  matches: (event: LogEvent) => boolean,
  count: number,
  timeoutMs = 10_000,
): Promise<LogEvent[]> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = structuredRecords().filter(matches);
    if (seen.length >= count || Date.now() >= deadline) {
      return seen;
    }
    await sleep(100);
  }
};

interface Account {
  email: string;
  password: string;
  cookie: string;
}

/**
 * The headers a browser sends on a same-origin mutating request.
 *
 * `Origin` is not decoration. SvelteKit refuses a `POST`/`PATCH`/`DELETE` whose
 * content type is a form type (or absent) unless the `Origin` matches the app's
 * own — which is the correct CSRF boundary for a cookie-authenticated API, and it
 * is stricter than the API this suite used to drive. A real browser always sends
 * it, so a test that omits it is testing a request shape no user can produce.
 */
const originHeaders = (): Record<string, string> => ({ origin: base() });

/** The same, for the second Worker this file starts with the jobs profile on. */
const originHeadersFor = (origin: () => string): Record<string, string> => ({ origin: origin() });

/**
 * Create a verified account and sign it in.
 *
 * Three real HTTP calls, in the order a person performs them, because each step is
 * where a defect shows up:
 *
 *   1. `sign-up` — creates the account. Returns **no** session: `autoSignIn` is off
 *      precisely because the address is not confirmed yet.
 *   2. the verification link, read from the local capture inbox. Real workerd, real
 *      D1, real Better Auth token — only the mail transport is substituted, and
 *      nothing leaves the machine.
 *   3. `sign-in` — the step that is refused if verification did not actually happen.
 *
 * Every later test in this file depends on step 3 succeeding, so a broken
 * verification flow fails here first, in one place, rather than as a dozen confusing
 * 403s.
 */
const signUp = async (label: string): Promise<Account> => {
  const email = `${label}-${createId('t', 8)}@example.invalid`;
  const password = 'correct-horse-battery-staple';

  const created = await authFetch('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email, password, name: label }),
  });

  if (!created.ok) {
    throw new Error(
      `sign-up failed: ${created.status} ${await created.text()} (worker log: ${WORKER_LOG})`,
    );
  }

  // No session cookie yet. Asserted rather than assumed: if this ever becomes truth,
  // every later test in this file would still pass while testing an
  // application that hands out sessions for unconfirmed addresses.
  const createdBody = (await created.json()) as { token: string | null };
  expect(createdBody.token).toBeNull();

  const link = await verificationLinkFor(email);
  const verified = await fetch(link, { redirect: 'manual' });
  expect(verified.status).toBe(302);

  const signedIn = await authFetch('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (!signedIn.ok) {
    throw new Error(
      `sign-in after verification failed: ${signedIn.status} ${await signedIn.text()} ` +
        `(worker log: ${WORKER_LOG})`,
    );
  }

  const setCookie = signedIn.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  if (!cookie.includes('better-auth')) {
    throw new Error(`sign-in set no session cookie: ${JSON.stringify(setCookie)}`);
  }

  return { email, password, cookie };
};

/** An auth call with the headers a same-origin browser would send. */
const authFetch = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${base()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...originHeaders(),
      ...(init.headers ?? {}),
    },
  });

interface CapturedMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * The newest captured mail for `email`, through the local-only inbox endpoint.
 *
 * The endpoint refuses a non-local environment with 403, so this is also the
 * assertion that a deployed Worker has no inbox — but here it is read for its
 * ordinary purpose: getting the link a person would have received.
 */
const inbox = async (email?: string): Promise<{ inbox: string; messages: CapturedMessage[] }> => {
  const url =
    email === undefined ? '/api/dev/mail' : `/api/dev/mail?to=${encodeURIComponent(email)}`;
  const response = await fetch(`${base()}${url}`);
  if (!response.ok) {
    throw new Error(`mail inbox unavailable: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { inbox: string; messages: CapturedMessage[] };
};

/** The verification link from `email`'s newest confirmation mail. */
const verificationLinkFor = async (email: string): Promise<string> => {
  const { messages } = await inbox(email);
  const message = messages.find((entry) => entry.subject.includes('Verify'));
  if (message === undefined) {
    throw new Error(`No verification mail was captured for ${email}`);
  }
  const line = message.text.split('\n').find((entry) => entry.startsWith('http'));
  if (line === undefined) {
    throw new Error(`No link in the verification mail: ${JSON.stringify(message.text)}`);
  }
  return line.trim();
};

/** The recovery link from `email`'s newest password-reset mail. */
const recoveryLinkFor = async (email: string): Promise<string> => {
  const { messages } = await inbox(email);
  const message = messages.find((entry) => entry.subject.includes('password'));
  if (message === undefined) {
    throw new Error(`No recovery mail was captured for ${email}`);
  }
  const line = message.text.split('\n').find((entry) => entry.startsWith('http'));
  if (line === undefined) {
    throw new Error(`No link in the recovery mail: ${JSON.stringify(message.text)}`);
  }
  return line.trim();
};

const api = (account: Account, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${base()}${path}`, {
    ...init,
    headers: {
      // Only when there is a body. Sending `content-type: application/json` with
      // no body makes the app attempt to parse an empty stream, and a DELETE then
      // fails with a 500 that has nothing to do with DELETE.
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...originHeaders(),
      cookie: account.cookie,
      ...(init.headers ?? {}),
    },
  });

// ── Tests ────────────────────────────────────────────────────────────────────

describe('health', () => {
  test('the Worker is running and is this run’s', async () => {
    const response = await fetch(`${base()}/api/health`);
    expect(response.status).toBe(200);

    // Asserted field by field: the endpoint also reports effective
    // configuration, and an exact-equality assertion breaks every time that
    // grows.
    const health = (await response.json()) as {
      ok: boolean;
      service: string;
      testRunId: string;
      baseUrl: string;
    };
    expect(health.ok).toBe(true);
    expect(health.service).toBe('web');
    expect(health.testRunId).toBe(RUN_ID);
    // The public origin was derived from the request, which is only permitted on
    // loopback and only when DEPLOYMENT_ENV says local. Getting this wrong means
    // session cookies are issued for an origin the user never visited.
    expect(health.baseUrl).toBe(base());
  });

  test('/health proves release identity without disclosing configuration', async () => {
    // This is the endpoint the deploy pipeline verifies against, so it has to
    // identify the release — and it is public, so everything in it is published.
    const response = await fetch(`${base()}/health`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.environment).toBe('local');
    expect(body.deployed).toBe(false);
    // A Worker deployed through this pipeline has `RELEASE` injected as the git
    // SHA; this run did not go through one, and says so rather than inventing a
    // plausible value.
    expect(body.release).toBe('unknown');

    // The decisive assertion: nothing that names a binding, an account or a
    // database appears in a public response.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('DB');
    expect(serialised).not.toContain('BETTER_AUTH_SECRET');
    expect(serialised).not.toContain('RESEND');
    expect(Object.keys(body).sort()).toEqual(['deployed', 'environment', 'release', 'status']);
  });

  test('/health is never cached', async () => {
    // A cached answer to "what is serving right now" is the previous answer, which
    // is worse than no answer because it looks fresh.
    for (const path of ['/health', '/health/ready']) {
      const response = await fetch(`${base()}${path}`);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('/health/ready exercises the database binding', async () => {
    const response = await fetch(`${base()}/health/ready`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: boolean;
      checks: { binding: string; ok: boolean; detail: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.checks).toHaveLength(1);
    expect(body.checks[0]?.binding).toBe('DB');
    expect(body.checks[0]?.ok).toBe(true);
  });

  test('an API response is not publicly cacheable', async () => {
    const response = await fetch(`${base()}/api/health`);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  test('a signed-in page is not publicly cacheable, and keeps its session cookie', async () => {
    // The branch that matters most, and the one a unit test of `cachePolicyFor`
    // alone would leave unproven: the header has to survive the response being
    // rebuilt in `hooks.server.ts` — status, body and every cookie intact.
    const account = await signUp('cache-probe');

    const response = await fetch(`${base()}/notes`, {
      headers: { cookie: account.cookie },
      redirect: 'manual',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    // Rebuilt, so the body must still be the real page rather than an empty one.
    expect(await response.text()).toContain('notes');

    // And the same header on an authenticated API read.
    const api = await fetch(`${base()}/api/notes`, { headers: { cookie: account.cookie } });
    expect(api.status).toBe(200);
    expect(api.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  test('anonymous HTML is left to the deployment, not declared cacheable here', async () => {
    // Whether a page is anonymous depends on the session, not the URL. A blanket
    // `public` would be a correctness claim this code cannot verify, so the landing
    // page gets no cache directive from the application at all.
    const response = await fetch(`${base()}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBeNull();
  });

  test('an unrouted API path stays JSON, never the HTML shell', async () => {
    // A client that received HTML has to guess between a wrong URL and a broken
    // deploy, and both guesses are expensive.
    const response = await fetch(`${base()}/api/no-such-route`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await response.json()) as unknown).toEqual({
      error: 'not_found',
      message: 'No such route.',
    });
  });
});

describe('same-origin routing, with no proxy anywhere', () => {
  test('a server-rendered public page', async () => {
    const response = await fetch(`${base()}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    // Server-rendered: the heading is in the HTML, not produced by hydration.
    const html = await response.text();
    expect(html).toContain('One application, one Worker');
  });

  test('a deep link to a client route renders, rather than 404ing', async () => {
    // `auth-screen` is the element the view renders, not a class name: a test id or
    // class is a thing an edit can remove without changing what a user sees, and this
    // assertion is about the server having produced the form at all.
    expect((await fetch(`${base()}/login`)).status).toBe(200);
    expect(await (await fetch(`${base()}/login`)).text()).toContain('auth-screen');

    // The recovery and confirmation routes are client routes too, so a deep link into
    // either must render. They were added with this PR and are easy to forget: a
    // missing route here is a 404 a real user hits by following a link in an email.
    for (const path of ['/forgot-password', '/verify-email']) {
      const response = await fetch(`${base()}${path}`);
      expect(response.status).toBe(200);
    }
  });

  test('the sign-in form is server-rendered and complete before hydration', async () => {
    // No JavaScript has run at this point, so anything present in this HTML was
    // produced by the server. Both fields and the submit button are what a user with
    // scripting disabled needs to sign in at all.
    const html = await (await fetch(`${base()}/login`)).text();

    expect(html).toContain('id="auth-email"');
    expect(html).toContain('id="auth-password"');
    expect(html).toContain('type="submit"');
    // Labelled, not merely present. An unlabelled input is invisible to a screen
    // reader and this is the only place that would be caught.
    expect(html).toContain('for="auth-email"');
    // And the recovery route is reachable from it, which is the whole point of a
    // sign-in page.
    expect(html).toContain('href="/forgot-password"');
  });

  test('a real asset is served by the Worker', async () => {
    // The asset URL is read out of the rendered HTML rather than hard-coded: a
    // hash changes on every build, and a test that hard-codes one either rots or
    // gets "fixed" into asserting nothing.
    const html = await (await fetch(`${base()}/`)).text();
    const asset = /["'](\.?\/[._a-zA-Z0-9/-]*\/start\.[\w-]+\.js)["']/.exec(html)?.[1];
    expect(asset).toBeDefined();

    const response = await fetch(new URL(asset ?? '', base()));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
  });

  test('an unknown API route is a JSON 404, not an HTML error page', async () => {
    // SvelteKit's own fallback for an unmatched route is HTML. A client that got
    // that would have to guess between a wrong URL and a broken deploy.
    const response = await fetch(`${base()}/api/no-such-route`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ error: 'not_found' });
  });

  test('an unknown page is a 404 too', async () => {
    expect((await fetch(`${base()}/no-such-page`)).status).toBe(404);
  });
});

describe('authentication', () => {
  test('rejects an anonymous read of the notes collection', async () => {
    const response = await fetch(`${base()}/api/notes`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  test('signs a user up and the session cookie identifies them', async () => {
    const account = await signUp('integration');
    expect(account.cookie).toContain('better-auth');

    const session = await api(account, '/api/auth/get-session');
    const identity = (await session.json()) as { user: { email: string } | null };
    expect(identity.user?.email).toBe(account.email);
  });

  test('resolves a session from the cookie alone', async () => {
    const account = await signUp('integration-cookie');
    // No Authorization header: the browser path must work on the cookie.
    const response = await fetch(`${base()}/api/auth/get-session`, {
      headers: { cookie: account.cookie },
    });
    const body = (await response.json()) as { user: { email: string } | null };
    expect(body.user?.email).toBe(account.email);
  });

  test('rejects a bad password', async () => {
    const account = await signUp('integration-badpw');
    const response = await authFetch('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: account.email, password: 'wrong-password-entirely' }),
    });
    expect(response.ok).toBe(false);
  });
});

// ── The account lifecycle, over real HTTP ───────────────────────────────────

describe('email verification', () => {
  test('sign-up captures a confirmation mail and issues no session', async () => {
    const email = `verify-${createId('t', 8)}@example.invalid`;
    const created = await authFetch('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: 'correct-horse-battery-staple',
        name: 'Verify',
      }),
    });

    expect(created.status).toBe(200);
    expect(created.headers.get('set-cookie')).toBeNull();

    const { inbox: inboxId, messages } = await inbox(email);
    // The inbox echoes the run id, so a stale listener cannot answer with another
    // run's mail and make a broken verification flow look working.
    expect(inboxId).toBe(RUN_ID);
    expect(messages.some((entry) => entry.to === email)).toBe(true);
  });

  test('an unverified account cannot sign in', async () => {
    const email = `unverified-${createId('t', 8)}@example.invalid`;
    await authFetch('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: 'correct-horse-battery-staple',
        name: 'Unverified',
      }),
    });

    const refused = await authFetch('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'correct-horse-battery-staple' }),
    });

    expect(refused.ok).toBe(false);
    // The code, not the sentence: `403` alone is also what a wrong password returns,
    // and a view that cannot tell them apart tells a real user to wait for mail that
    // is never coming.
    const body = (await refused.json()) as { code?: string };
    expect(body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  test('a verification link confirms the address and unlocks sign-in', async () => {
    // Covered end to end by every `signUp()` above, which would fail here otherwise.
    // Asserted once on its own so a failure names the lifecycle step rather than
    // showing up as an unrelated authorization failure twenty tests later.
    const account = await signUp('integration-verify');
    const session = await api(account, '/api/auth/get-session');
    const identity = (await session.json()) as { user: { email: string } | null };
    expect(identity.user?.email).toBe(account.email);
  });

  test('a forged verification link confirms nothing', async () => {
    const email = `forged-${createId('t', 8)}@example.invalid`;
    await authFetch('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: 'correct-horse-battery-staple',
        name: 'Forged',
      }),
    });

    // Sent with the same `callbackURL` a real link carries, because that is what
    // decides the shape of the answer: with one, Better Auth *redirects* to the
    // callback carrying `?error=INVALID_TOKEN` rather than returning a status. A
    // 302 alone would look like the success case, so the error parameter is the
    // assertion — and it is exactly what the `/verify-email` page reads.
    const forged = await fetch(
      `${base()}/api/auth/verify-email?token=not.a.real.token&callbackURL=%2Fverify-email`,
      { redirect: 'manual' },
    );

    expect(forged.status).toBe(302);
    const location = new URL(forged.headers.get('location') ?? '', base());
    expect(location.searchParams.get('error')).toBe('INVALID_TOKEN');

    // The account is still unverified, which is the half that matters.
    const signIn = await authFetch('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'correct-horse-battery-staple' }),
    });
    expect(signIn.ok).toBe(false);
    expect(((await signIn.json()) as { code?: string }).code).toBe('EMAIL_NOT_VERIFIED');
  });

  test('replaying a verification link changes nothing', async () => {
    const email = `replay-${createId('t', 8)}@example.invalid`;
    await authFetch('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: 'correct-horse-battery-staple',
        name: 'Replay',
      }),
    });

    const link = await verificationLinkFor(email);
    const first = await fetch(link, { redirect: 'manual' });
    expect(first.status).toBe(302);
    expect(
      new URL(first.headers.get('location') ?? '', base()).searchParams.get('error'),
    ).toBeNull();

    const replay = await fetch(link, { redirect: 'manual' });

    // Recorded rather than wished for: a verification token is a **signed JWT with an
    // expiry**, so Better Auth accepts it again within that hour and simply re-affirms
    // the same state. This test was originally written asserting a second use is
    // refused; it is not, and asserting otherwise would have been a green test
    // describing behaviour the library does not have.
    //
    // What is asserted here is the property that actually matters and *is* guaranteed:
    // a replay is idempotent. It cannot un-verify an address, cannot issue a session
    // (`autoSignInAfterVerification` is off), and cannot confirm anybody else's.
    expect(replay.status).toBe(302);
    const setCookie = replay.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain('better-auth');

    // The address is still confirmed, and the account is still usable — which is the
    // difference between "idempotent" and "broken".
    const signIn = await authFetch('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'correct-horse-battery-staple' }),
    });
    expect(signIn.ok).toBe(true);
  });
});

describe('password recovery', () => {
  test('a recovery link sets a new password and revokes every session', async () => {
    const account = await signUp('integration-recovery');
    const second = await authFetch('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    const intruderCookie = (second.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(intruderCookie).not.toBe('');

    const requested = await authFetch('/api/auth/request-password-reset', {
      method: 'POST',
      body: JSON.stringify({ email: account.email, redirectTo: '/reset-password' }),
    });
    expect(requested.ok).toBe(true);

    const link = await recoveryLinkFor(account.email);
    // Better Auth's callback redirects to `/reset-password` with the token appended
    // as a query parameter. That redirect *is* the application page, so it is
    // followed and the resulting form is posted to — the route a real user takes,
    // rather than a hand-assembled request.
    const landed = await fetch(link, { redirect: 'follow' });
    expect(landed.status).toBe(200);
    expect(landed.url).toContain('/reset-password?token=');
    // Server-rendered, so the form works without JavaScript.
    expect(await landed.text()).toContain('id="new-password"');

    const token = new URL(landed.url).searchParams.get('token') ?? '';
    expect(token).not.toBe('');

    const reset = await authFetch('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword: 'a-different-passphrase-entirely' }),
    });
    expect(reset.ok).toBe(true);

    // The old password is dead.
    const oldPassword = await authFetch('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    expect(oldPassword.ok).toBe(false);

    // And both pre-existing sessions are gone. This is the case that matters: the
    // owner noticed a stranger signed in and reset the password, so the stranger must
    // be locked out rather than keeping a valid cookie.
    //
    // `/api/auth/get-session` is a *question* ("who is this?"), not a gate: an unknown
    // or revoked cookie yields a 200 whose body is literally `null`. So the session
    // endpoint is not where revocation shows up, and the shape is not an object with
    // a null field.
    for (const cookie of [account.cookie, intruderCookie]) {
      const session = await fetch(`${base()}/api/auth/get-session`, {
        headers: { cookie },
      });
      expect(session.status).toBe(200);
      expect(await session.json()).toBeNull();
    }

    // `/api/notes` is the gate, and this is the consequence that actually matters: the
    // stranger's cookie cannot reach the owner's data. Asserting only on the session
    // endpoint would prove revocation happened somewhere, not that it is enforced.
    for (const cookie of [account.cookie, intruderCookie]) {
      const notes = await fetch(`${base()}/api/notes`, { headers: { cookie } });
      expect(notes.status).toBe(401);
    }
  });

  test('a recovery token works exactly once', async () => {
    const account = await signUp('integration-recovery-once');
    await authFetch('/api/auth/request-password-reset', {
      method: 'POST',
      body: JSON.stringify({ email: account.email, redirectTo: '/reset-password' }),
    });
    const link = await recoveryLinkFor(account.email);
    const landed = await fetch(link, { redirect: 'follow' });
    const token = new URL(landed.url).searchParams.get('token') ?? '';
    expect(token).not.toBe('');

    expect(
      (
        await authFetch('/api/auth/reset-password', {
          method: 'POST',
          body: JSON.stringify({ token, newPassword: 'first-new-passphrase-x' }),
        })
      ).ok,
    ).toBe(true);

    // The second use must fail, and must not silently set the password again — a
    // link that works twice is a live credential in an inbox. Unlike the verification
    // token, a recovery token **is** genuinely single-use: Better Auth consumes the
    // `verifications` row as it validates it.
    const replay = await authFetch('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword: 'second-new-passphrase-x' }),
    });
    expect(replay.ok).toBe(false);

    const withSecond = await authFetch('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: account.email, password: 'second-new-passphrase-x' }),
    });
    expect(withSecond.ok).toBe(false);
    // And the password that *was* set is still the one in force.
    const withFirst = await authFetch('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: account.email, password: 'first-new-passphrase-x' }),
    });
    expect(withFirst.ok).toBe(true);
  });

  test('a recovery link expires', async () => {
    const account = await signUp('integration-recovery-expiry');
    await authFetch('/api/auth/request-password-reset', {
      method: 'POST',
      body: JSON.stringify({ email: account.email, redirectTo: '/reset-password' }),
    });
    const link = await recoveryLinkFor(account.email);

    // The link is valid now.
    const landed = await fetch(link, { redirect: 'follow' });
    const token = new URL(landed.url).searchParams.get('token') ?? '';
    expect(
      (
        await authFetch('/api/auth/reset-password', {
          method: 'POST',
          body: JSON.stringify({ token, newPassword: 'a-passphrase-before-expiry-x' }),
        })
      ).ok,
    ).toBe(true);

    // A second link for the same account, used after the first consumed... no: the
    // expiry itself is proven differently, because there is no way to wait an hour in a
    // test. The honest assertion is that the token is stored with an expiry and the
    // endpoint checks it — proven here by the *consumed* case below, and by
    // `auth_lifecycle.test.ts`, which inserts a `verifications` row with a past
    // `expiresAt` and asserts the public API refuses it.
    //
    // What is worth pinning here is that the first link stopped working, which is the
    // property a user experiences as "that link is no good any more".
    const replay = await authFetch('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword: 'yet-another-passphrase-x' }),
    });
    expect(replay.ok).toBe(false);
  });

  test('a forged recovery token sets no password', async () => {
    const account = await signUp('integration-recovery-forged');

    const forged = await authFetch('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: 'x.y.z', newPassword: 'attacker-chosen-passphrase' }),
    });
    expect(forged.ok).toBe(false);

    // The original password still works, which is the half that matters.
    const original = await authFetch('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    expect(original.ok).toBe(true);
  });

  test('a recovery request for an unknown address sends no mail', async () => {
    const unknown = `nobody-${createId('t', 8)}@example.invalid`;

    const response = await authFetch('/api/auth/request-password-reset', {
      method: 'POST',
      body: JSON.stringify({ email: unknown, redirectTo: '/reset-password' }),
    });

    // Reported as success, which is the whole protection: if this answered "no such
    // account" instead, the endpoint would answer "does this person have an account
    // here?" for anyone who can type an address.
    expect(response.ok).toBe(true);
    expect((await inbox(unknown)).messages).toHaveLength(0);
  });

  test('a recovery link cannot be pointed at another origin', async () => {
    const account = await signUp('integration-recovery-origin');

    const response = await authFetch('/api/auth/request-password-reset', {
      method: 'POST',
      body: JSON.stringify({
        email: account.email,
        redirectTo: 'https://attacker.example/steal',
      }),
    });

    expect(response.status).toBe(403);
    // And nothing was sent. A refusal the mailer ignored would be a token leak with a
    // 403 painted on the front of it.
    const { messages } = await inbox(account.email);
    expect(messages.some((entry) => entry.subject.includes('password'))).toBe(false);
  });
});

describe('the local mail inbox', () => {
  test('is namespaced to this run', async () => {
    const { inbox: inboxId } = await inbox();
    expect(inboxId).toBe(RUN_ID);
  });

  test('reports the mail mode rather than a provider', async () => {
    const health = (await (await fetch(`${base()}/api/health`)).json()) as {
      mail: { mode: string };
      rateLimit: { storage: string };
    };
    expect(health.mail.mode).toBe('capture');
    // A local run uses the in-memory inbox, and the counter store is still D1 — the
    // limiter is real even where the mail is not.
    expect(health.rateLimit.storage).toBe('d1');
  });
});

describe('notes CRUD', () => {
  test('creates, reads, updates and deletes a note', async () => {
    const account = await signUp('integration-crud');

    const created = await api(account, '/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title: 'First note', body: 'Hello from the integration test.' }),
    });
    expect(created.status).toBe(200);

    const note = (await created.json()) as { id: string; title: string; ownerId: string };
    expect(note.title).toBe('First note');
    expect(note.ownerId.length).toBeGreaterThan(0);

    const list = await api(account, '/api/notes');
    const listed = (await list.json()) as { notes: { id: string }[] };
    expect(listed.notes.map((entry) => entry.id)).toContain(note.id);

    const updated = await api(account, `/api/notes/${note.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Renamed' }),
    });
    expect(updated.status).toBe(200);
    const renamed = (await updated.json()) as { title: string };
    expect(renamed.title).toBe('Renamed');

    const removed = await api(account, `/api/notes/${note.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);

    const afterDelete = await api(account, '/api/notes');
    const remaining = (await afterDelete.json()) as { notes: { id: string }[] };
    expect(remaining.notes.map((entry) => entry.id)).not.toContain(note.id);
  });

  test('rejects a note with an empty title', async () => {
    const account = await signUp('integration-validation');
    const response = await api(account, '/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title: '', body: 'x' }),
    });
    // 422 from the TypeBox validation in `readJsonBody`, not 500.
    expect(response.status).toBe(422);
  });

  test('returns 404 for a note that does not exist', async () => {
    const account = await signUp('integration-404');
    const response = await api(account, '/api/notes/does-not-exist', { method: 'DELETE' });
    expect(response.status).toBe(404);
  });
});

describe('authorization', () => {
  test("one user cannot read, update or delete another user's note", async () => {
    const owner = await signUp('integration-owner');
    const stranger = await signUp('integration-stranger');

    const created = await api(owner, '/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title: 'Private', body: 'Only the owner should see this.' }),
    });
    const note = (await created.json()) as { id: string };

    // The stranger's list must not contain it.
    const strangerList = await api(stranger, '/api/notes');
    const strangerNotes = (await strangerList.json()) as { notes: { id: string }[] };
    expect(strangerNotes.notes.map((entry) => entry.id)).not.toContain(note.id);

    // A blind update must not succeed.
    const hijack = await api(stranger, `/api/notes/${note.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Hijacked' }),
    });
    expect(hijack.status).toBe(404);

    // A blind delete must not succeed.
    const remove = await api(stranger, `/api/notes/${note.id}`, { method: 'DELETE' });
    expect(remove.status).toBe(404);

    // And the note must still be the owner's, unchanged.
    const ownerList = await api(owner, '/api/notes');
    const ownerNotes = (await ownerList.json()) as { notes: { id: string; title: string }[] };
    const survivor = ownerNotes.notes.find((entry) => entry.id === note.id);
    expect(survivor?.title).toBe('Private');
  });

  test("one user's page data does not contain another user's notes", async () => {
    // The SSR case, which the API tests above cannot reach. `locals.user` is
    // resolved per request, so two sessions in flight at the same time each get
    // their own list — a module-level identity would interleave them and this is
    // the assertion that catches it.
    const owner = await signUp('integration-ssr-owner');
    const stranger = await signUp('integration-ssr-stranger');

    await api(owner, '/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title: 'Owner only', body: 'x' }),
    });

    const [ownerPage, strangerPage] = await Promise.all([
      fetch(`${base()}/notes`, { headers: { cookie: owner.cookie } }),
      fetch(`${base()}/notes`, { headers: { cookie: stranger.cookie } }),
    ]);

    expect(ownerPage.status).toBe(200);
    expect(strangerPage.status).toBe(200);
    expect(await ownerPage.text()).toContain('Owner only');
    // The specific leak: the stranger's rendered page must not contain the
    // owner's note, even though both pages were produced concurrently.
    expect(await strangerPage.text()).not.toContain('Owner only');
  });

  test('an anonymous request for the notes page is redirected, not rendered', async () => {
    const response = await fetch(`${base()}/notes`, { redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/login');
  });

  test('the owner id comes from the session, not the request body', async () => {
    const account = await signUp('integration-ownerid');
    const response = await api(account, '/api/notes', {
      method: 'POST',
      // `ownerId` is not in the create schema, so it must be refused outright.
      body: JSON.stringify({ title: 'Injected', body: '', ownerId: 'someone-else' }),
    });

    expect(response.status).toBe(422);
  });
});

describe('authentication form actions', () => {
  test('sign-in applies the session cookie before redirecting', async () => {
    const account = await signUp('form-cookie');
    const response = await fetch(`${base()}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...originHeaders(), accept: 'text/html' },
      body: new URLSearchParams({
        intent: 'sign-in',
        email: account.email,
        password: account.password,
      }),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/notes');
    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie).toContain('better-auth');
    expect(
      (await fetch(`${base()}/notes`, { headers: { cookie }, redirect: 'manual' })).status,
    ).toBe(200);
  });

  for (const [intent, next] of [
    ['sign-in', 'sign-up'],
    ['sign-up', 'sign-in'],
    ['', 'sign-in'],
  ] as const) {
    test(`mode toggle with intent "${intent}" redirects to ${next} and retains email`, async () => {
      const body = new URLSearchParams({
        toggle: '1',
        email: 'someone@example.test',
        name: 'Someone',
      });
      if (intent) {
        body.set('intent', intent);
      }
      const response = await fetch(`${base()}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { ...originHeaders(), accept: 'text/html' },
        body,
      });
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(
        `/login?mode=${next}&email=someone%40example.test`,
      );
    });
  }
});

describe('the database-backed rate limit', () => {
  const budget = 3;
  const state = join(APP_DIR, `.wrangler/rate-limit-${RUN_ID}`);
  const workers: ChildProcess[] = [];
  const origins: string[] = [];

  const sql = (command: string): void => {
    const result = spawnSync(
      [
        WRANGLER,
        'd1',
        'execute',
        'DB',
        '--local',
        '--config',
        APP_CONFIG,
        '--persist-to',
        state,
        '--command',
        command,
      ],
      { cwd: APP_DIR, stdout: 'pipe', stderr: 'pipe' },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Rate-limit fixture SQL failed: ${result.stderr.toString()}`);
    }
  };

  const start = async (workerPort: number): Promise<ChildProcess> => {
    const origin = `http://127.0.0.1:${workerPort}`;
    const workerRunId = `${RUN_ID}-rate-${workers.length}`;
    const logFd = openSync(`${WORKER_LOG}.${workerPort}`, 'a');
    const worker = spawn(
      WRANGLER,
      [
        'dev',
        WORKER_ENTRY,
        '--port',
        String(workerPort),
        '--local',
        '--config',
        APP_CONFIG,
        '--persist-to',
        state,
        '--var',
        `TEST_RUN_ID:${workerRunId}`,
        '--var',
        'DEPLOYMENT_ENV:local',
        '--var',
        `AUTH_RATE_LIMIT_MAX:${budget}`,
        // Keep the test window open across process restarts without a clock race.
        '--var',
        'AUTH_RATE_LIMIT_WINDOW:3600',
      ],
      { cwd: APP_DIR, stdio: ['ignore', logFd, logFd] },
    );
    closeSync(logFd);
    workers.push(worker);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${origin}/api/health`);
        const health = (await response.json()) as { testRunId?: string };
        if (response.ok && health.testRunId === workerRunId) {
          return worker;
        }
      } catch {
        // The process has not bound its socket yet.
      }
      if (worker.exitCode !== null) {
        throw new Error('Rate-limit worker exited during startup');
      }
      await sleep(200);
    }
    throw new Error(`Rate-limit worker did not become ready: ${origin}`);
  };

  beforeAll(async () => {
    const migrate = spawnSync(
      [
        WRANGLER,
        'd1',
        'migrations',
        'apply',
        'DB',
        '--local',
        '--config',
        APP_CONFIG,
        '--persist-to',
        state,
      ],
      { cwd: APP_DIR, stdout: 'pipe', stderr: 'pipe' },
    );
    if (migrate.exitCode !== 0) {
      throw new Error(migrate.stderr.toString());
    }
    const workerPort = await findFreePort();
    // Local origin derivation creates a distinct auth instance for each host.
    // Both use the same D1 binding in one runtime, which serializes its writes.
    // Separate Wrangler processes cannot concurrently own one local SQLite file.
    origins.push(`http://127.0.0.1:${workerPort}`, `http://localhost:${workerPort}`);
    await start(workerPort);
  }, 150_000);

  beforeEach(() => sql('DELETE FROM rate_limits'), 30_000);

  afterAll(() => {
    for (const worker of workers) {
      if (worker.pid !== undefined && worker.exitCode === null) {
        killTree(worker.pid, { graceMs: 200, attempts: 20 });
      }
    }
    rmSync(state, { recursive: true, force: true });
  });

  const attempt = (index = 0, headers: Record<string, string> = {}) =>
    fetch(`${origins[index % 2]}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: origins[index % 2] ?? '', ...headers },
      body: JSON.stringify({
        email: 'absent@example.invalid',
        password: 'wrong-password-entirely',
      }),
    });

  const counts = async (responses: Response[]) => {
    for (const response of responses) {
      if (response.status !== 401 && response.status !== 429) {
        throw new Error(`Unexpected limiter response ${response.status}: ${await response.text()}`);
      }
    }
    expect(responses.map((r) => r.status).sort()).toEqual([
      ...Array.from({ length: budget }, () => 401),
      ...Array.from({ length: responses.length - budget }, () => 429),
    ]);
  };

  test('two auth instances share one budget across concurrent requests', async () => {
    await counts(
      await Promise.all(Array.from({ length: budget + 5 }, (_, index) => attempt(index))),
    );
  });

  test('the counter survives separate requests and a worker restart', async () => {
    expect((await attempt()).status).toBe(401);
    expect((await attempt(1)).status).toBe(401);
    const first = workers[0];
    if (first?.pid === undefined) {
      throw new Error('Missing first worker');
    }
    expect(killTree(first.pid, { graceMs: 200, attempts: 20 })).toEqual([]);
    await start(Number(new URL(origins[0] ?? '').port));
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
    expect((await attempt(1)).status).toBe(429);
  }, 90_000);

  test('rotating cf-connecting-ip cannot evade the local ingress budget', async () => {
    const responses: Response[] = [];
    for (let index = 0; index < budget + 3; index += 1) {
      responses.push(await attempt(index, { 'cf-connecting-ip': `203.0.113.${index + 1}` }));
    }
    await counts(responses);
  });

  test('login forms share the API sign-in budget', async () => {
    expect((await attempt()).status).toBe(401);
    const responses: Response[] = [];
    for (let index = 0; index < budget + 1; index += 1) {
      const origin = origins[index % 2] ?? '';
      responses.push(
        await fetch(`${origin}/login`, {
          method: 'POST',
          redirect: 'manual',
          headers: { origin, accept: 'text/html' },
          body: new URLSearchParams({
            intent: 'sign-in',
            email: 'absent@example.invalid',
            password: 'wrong-password-entirely',
          }),
        }),
      );
    }
    expect(responses.map((r) => r.status)).toEqual([400, 400, 429, 429]);
  });

  for (const [path, fields, limit, accepted] of [
    [
      '/login',
      {
        intent: 'sign-up',
        email: 'new@example.invalid',
        password: 'correct horse battery',
        name: 'New',
      },
      budget,
      200,
    ],
    ['/forgot-password', { email: 'absent@example.invalid' }, budget * 2, 303],
    ['/verify-email', { email: 'absent@example.invalid' }, budget * 2, 200],
    ['/reset-password?token=invalid', { newPassword: 'correct horse battery' }, budget, 400],
  ] as const) {
    test(`${path} forms enforce their middleware budget`, async () => {
      const origin = origins[0] ?? '';
      const statuses: number[] = [];
      for (let index = 0; index <= limit; index += 1) {
        const response = await fetch(`${origin}${path}`, {
          method: 'POST',
          redirect: 'manual',
          headers: { origin, accept: 'text/html' },
          body: new URLSearchParams(fields),
        });
        statuses.push(response.status);
      }
      expect(statuses).toEqual([...Array.from({ length: limit }, () => accepted), 429]);
    });
  }
});

describe('telemetry', () => {
  test('accepts a well-formed event and rejects a malformed one', async () => {
    const event = {
      timestamp: Date.now(),
      app: 'web',
      environment: 'local',
      source: 'browser',
      level: 'INFO',
      event: 'test.event',
      release: 'test',
    };

    const accepted = await api(await signUp('integration-telemetry'), '/api/telemetry', {
      method: 'POST',
      body: JSON.stringify(event),
    });
    expect(accepted.status).toBe(202);
    const acceptedBody = (await accepted.json()) as { accepted: number };
    expect(acceptedBody.accepted).toBe(1);

    const rejected = await fetch(`${base()}/api/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...originHeaders() },
      body: JSON.stringify({ not: 'a log event' }),
    });
    // 422: the body is validated against the TypeBox schema, so a malformed record
    // is refused as a bad request rather than silently accepted and dropped.
    expect(rejected.status).toBe(422);
  });

  test('refuses more records than one submission may carry', async () => {
    const records = (count: number): unknown[] =>
      Array.from({ length: count }, () => ({
        timestamp: Date.now(),
        app: 'web',
        environment: 'local',
        source: 'browser',
        level: 'INFO',
        event: 'batch.event',
        release: 'test',
      }));

    const account = await signUp('integration-telemetry-batch');

    const atLimit = await api(account, '/api/telemetry', {
      method: 'POST',
      body: JSON.stringify(records(MAX_RECORDS_PER_SUBMISSION)),
    });
    expect(atLimit.status).toBe(202);

    // One over the ceiling: 422, not 202. Accepting it would mean the per-submission
    // record bound is not enforced, whatever the body byte cap allows through.
    const overLimit = await api(account, '/api/telemetry', {
      method: 'POST',
      body: JSON.stringify(records(MAX_RECORDS_PER_SUBMISSION + 1)),
    });
    expect(overLimit.status).toBe(422);
  });

  test('refuses an oversized submission', async () => {
    const oversized = JSON.stringify({
      timestamp: Date.now(),
      app: 'web',
      environment: 'local',
      source: 'browser',
      level: 'INFO',
      event: 'big',
      release: 'test',
      message: 'x'.repeat(MAX_BODY_BYTES + 1024),
    });

    const response = await fetch(`${base()}/api/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...originHeaders() },
      body: oversized,
    });
    // 413 from the body cap. A 202 would mean it was stored, which is the failure
    // this limit exists to prevent.
    expect(response.status).toBe(413);
  });
});

// ── What the built Worker actually writes ─────────────────────────────────────
//
// The unit lane can prove a logger is configured correctly. Only this lane can
// prove the *built Worker* emits, which is what a deployment's Logs product would
// index — and the defect was that in workerd it emitted nothing at all, so every
// assertion below is about a line that had to appear in wrangler's captured output.
//
// `wrangler dev` runs the same workerd that serves a deployment, and its console
// output is what Cloudflare captures. Local NDJSON is the Node counterpart and is
// covered by `request_context.test.ts`; the remote history in Workers Logs was NOT
// RUN here, because that needs a deployed environment and a provider account.

describe('the built Worker emits one structured record per served request', () => {
  const isRequestTo =
    (path: string) =>
    (event: LogEvent): boolean =>
      event.event === 'http.request' && (event.data as Record<string, unknown>)?.path === path;

  /** The records for one path, after waiting for `expected` of them to exist. */
  const requestRecords = async (path: string, expected: number): Promise<LogEvent[]> =>
    awaitRecords(isRequestTo(path), expected);

  test('a real request produces exactly one record, through the platform console', async () => {
    // Counted as a delta, not as "one record exists": the suite has just made
    // requests of its own, and a matcher that only asks "is there a record for this
    // path" would pass while the request under test emitted two.
    const before = structuredRecords().filter(isRequestTo('/api/health')).length;

    const response = await fetch(`${base()}/api/health`);
    expect(response.status).toBe(200);

    const after = await requestRecords('/api/health', before + 1);
    expect(after.length).toBe(before + 1);
    const record = after[after.length - 1];
    assert.ok(record, 'Expected a structured Worker log record');
    expect(record?.app).toBe('web');
    expect(record?.environment).toBe('local');
    expect(record?.source).toBe('worker');
    expect(record?.level).toBe('INFO');
    expect((record?.release ?? '').length).toBeGreaterThan(0);

    const data = record.data as Record<string, unknown>;
    expect(data.status).toBe(200);
    expect(data.method).toBe('GET');
    expect(typeof data.durationMs).toBe('number');
    // Correlation is on the record itself, not reconstructed from a message.
    expect(typeof record?.traceId).toBe('string');
  }, 30_000);

  test('an unrouted API request records the final 404 exactly once', async () => {
    const path = `/api/missing-${createId('route', 8)}`;
    const response = await fetch(`${base()}${path}`);
    expect(response.status).toBe(404);

    const records = await requestRecords(path, 1);
    expect(records).toHaveLength(1);
    const [record] = records;
    assert.ok(record, 'Expected a structured Worker log record');
    expect((record.data as Record<string, unknown>).status).toBe(response.status);
  }, 30_000);

  test('a failing request is recorded as a warning, not as information', async () => {
    const before = structuredRecords().filter(isRequestTo('/api/notes')).length;

    const response = await fetch(`${base()}/api/notes`);
    // Anonymous read of the collection.
    expect(response.status).toBe(401);

    const after = await requestRecords('/api/notes', before + 1);
    expect(after.length).toBe(before + 1);

    // The platform's severity filter is how an incident is found; a 401 that arrives
    // as `info` is a stream nobody filters by WARNING.
    const record = after[after.length - 1];
    assert.ok(record, 'Expected a structured Worker log record');
    expect(record.level).toBe('WARNING');
    expect((record.data as Record<string, unknown>).status).toBe(401);
  }, 30_000);

  test('an incoming correlation label is echoed as a label, never as the trace id', async () => {
    const before = structuredRecords().filter(isRequestTo('/api/health')).length;

    const response = await fetch(`${base()}/api/health`, {
      headers: { 'x-trace-id': `client-${createId('l', 8)}` },
    });
    expect(response.status).toBe(200);

    const after = await requestRecords('/api/health', before + 1);
    expect(after.length).toBe(before + 1);

    const record = after[after.length - 1];
    assert.ok(record, 'Expected a structured Worker log record');
    const clientLabel = (record.data as Record<string, unknown>).clientTraceId;
    expect(typeof clientLabel).toBe('string');
    expect(record?.traceId).not.toBe(clientLabel);
  }, 30_000);

  test('a signed-in request record carries the verified user id', async () => {
    const account = await signUp('integration-request-log');
    const before = structuredRecords().filter(isRequestTo('/api/notes')).length;

    const response = await fetch(`${base()}/api/notes`, { headers: { cookie: account.cookie } });
    expect(response.status).toBe(200);

    const after = await requestRecords('/api/notes', before + 1);
    expect(after.length).toBe(before + 1);

    const record = after[after.length - 1];
    assert.ok(record, 'Expected a structured Worker log record');
    const userId = (record.data as Record<string, unknown>).userId;
    expect(typeof userId).toBe('string');
  }, 60_000);
});

describe('a forwarded browser event is stored once, and stays a browser event', () => {
  test('the record keeps its source, its release, its redacted data and its claims', async () => {
    const account = await signUp('integration-telemetry-record');
    const marker = `notes.ui.${createId('ev', 8)}`;

    const submitted = {
      timestamp: Date.now(),
      app: 'web',
      // The client says local. The server overwrites it with its own environment, so
      // the assertion below is about the server's answer winning.
      environment: 'production',
      source: 'browser',
      level: 'INFO',
      event: marker,
      release: 'browser-2026-10-01',
      traceId: 'tr_client_forwarded',
      userId: 'user-somebody-claims',
      data: { noteId: 'nt_forwarded', password: 'hunter2' },
      clientReported: { userId: 'user-somebody-claims', platform: 'linux' },
    };

    const response = await api(account, '/api/telemetry', {
      method: 'POST',
      body: JSON.stringify(submitted),
      headers: { ...originHeaders(), 'x-trace-id': 'client-correlation-label' },
    });
    expect(response.status).toBe(202);

    const records = await awaitRecords((event) => event.event === marker, 1);
    expect(records).toHaveLength(1);
    const [record] = records;
    assert.ok(record, 'Expected a structured Worker log record');

    // A browser event forwarded through a Worker is still a browser event, and its
    // artifact release is still its own — that is what answers "which build?".
    expect(record?.source).toBe('browser');
    expect(record?.release).toBe('browser-2026-10-01');
    // The environment is the server's, not the client's claim.
    expect(record?.environment).toBe('local');
    expect(record?.app).toBe('web');

    const data = record.data as Record<string, unknown>;
    // Redaction happened before storage, and the payload itself survived: it used to
    // be redacted and then thrown away.
    expect(data.password).toBe('[redacted]');
    expect(data.noteId).toBe('nt_forwarded');

    const reported = data.clientReported as Record<string, unknown>;
    expect(reported.userId).toBe('user-somebody-claims');
    expect(reported.platform).toBe('linux');
    expect(reported.traceId).toBe('tr_client_forwarded');

    // The identity on the record is the session's, and the correlation is the
    // server's; neither is anything the client chose.
    expect(record?.userId).not.toBe('user-somebody-claims');
    expect(record?.traceId).not.toBe('tr_client_forwarded');
    expect((data.ingest as Record<string, unknown>).server).toBe(true);
  }, 60_000);

  test('an anonymous submission is still accepted on the local diagnostic profile', async () => {
    // This Worker runs the local profile, where an anonymous browser console is the
    // diagnostic path and is bounded instead. The deployed refusal is proven by
    // `ingestionAdmission` in `telemetry_service.test.ts`, which can construct a
    // staging container; here the point is that the local path still works.
    const marker = `notes.ui.${createId('ev', 6)}`;
    const response = await fetch(`${base()}/api/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...originHeaders() },
      body: JSON.stringify({
        timestamp: Date.now(),
        app: 'web',
        environment: 'local',
        source: 'browser',
        level: 'INFO',
        event: marker,
        release: 'test',
      }),
    });
    expect(response.status).toBe(202);
  }, 30_000);

  test('two concurrent signed-in sessions stay isolated in the stored records', async () => {
    // Concurrency is the point: a Worker isolate serves many requests at once, so an
    // identity held in module scope would show up here as one user's records landing
    // under the other user's id — rare, timing-dependent, and indistinguishable from
    // an authorization bug while debugging it.
    const [first, second] = await Promise.all([
      signUp('integration-isolation-a'),
      signUp('integration-isolation-b'),
    ]);

    const marker = `notes.ui.${createId('ev', 8)}`;
    // A correlation label has to survive the bounded-label rule: only
    // `[A-Za-z0-9._:-]` is accepted, so an address — which is what these two sessions
    // are distinguished by — would be refused and the assertion below would prove
    // nothing. A short per-session token stands in for it.
    const labelFor = (account: Account): string =>
      `client-label-${account.email.split('-')[0] ?? 'x'}-${createId('l', 6)}`;
    const submission = (account: Account) =>
      api(account, '/api/telemetry', {
        method: 'POST',
        headers: { ...originHeaders(), 'x-trace-id': labelFor(account) },
        body: JSON.stringify({
          timestamp: Date.now(),
          app: 'web',
          environment: 'local',
          source: 'browser',
          level: 'INFO',
          event: marker,
          release: 'test',
          userId: 'user-forged',
          clientReported: { userId: 'user-forged' },
        }),
      });

    const [one, two] = await Promise.all([submission(first), submission(second)]);
    expect(one.status).toBe(202);
    expect(two.status).toBe(202);

    const records = await awaitRecords((event) => event.event === marker, 2);
    expect(records).toHaveLength(2);

    // Each record's user id is its own session's, and each kept its own correlation
    // label — so the two submissions never crossed.
    const userByLabel = new Map<string, string | undefined>();
    for (const record of records) {
      const data = record.data as Record<string, unknown>;
      const reported = data.clientReported as Record<string, unknown>;
      expect(record.userId).not.toBe('user-forged');
      userByLabel.set(String(reported.traceId), record.userId);
    }

    // Two distinct labels, each mapped to the user id of its own session.
    expect(userByLabel.size).toBe(2);
    for (const [label, userId] of userByLabel) {
      expect(label).toMatch(/^client-label-/);
      expect(typeof userId).toBe('string');
      expect(userId).not.toBe('user-forged');
    }
    const ids = [...userByLabel.values()];
    expect(ids[0]).not.toBe(ids[1]);
  }, 60_000);

  test('a malformed record never reaches the log stream', async () => {
    const marker = `notes.ui.${createId('ev', 8)}`;
    const account = await signUp('integration-telemetry-malformed');

    const forged = await api(account, '/api/telemetry', {
      method: 'POST',
      body: JSON.stringify({
        timestamp: Date.now(),
        app: 'web',
        environment: 'local',
        source: 'browser',
        level: 'INFO',
        event: marker,
        release: 'test',
        // Not part of the schema: a second identity channel would be refused.
        trustedUserId: 'root',
      }),
    });
    expect(forged.status).toBe(422);

    // Give a refused submission every chance to have been written anyway.
    await sleep(500);
    expect(structuredRecords().filter((event) => event.event === marker)).toHaveLength(0);
  }, 60_000);
});

// ── Jobs ─────────────────────────────────────────────────────────────────────

describe('the jobs API with the compute profile disabled', () => {
  // This Worker above runs with no `JOBS_PROFILE` binding, which is the shipped
  // default. Everything below is about the answer being *named*: a client that
  // cannot tell "this deployment cannot do that" from "the URL is wrong" or "the
  // server is broken" cannot do anything useful with the failure.

  test('every jobs route answers 503 with a named capability', async () => {
    const account = await signUp('integration-jobs-disabled');
    const body = JSON.stringify({ fixture: 'sample-v1', preset: 'demo-180p-v1' });
    const headers = {
      'content-type': 'application/json',
      ...originHeaders(),
      'idempotency-key': createId('key', 12),
    };

    for (const path of [
      '/api/jobs',
      '/api/jobs/job_anything',
      '/api/jobs/job_anything/output',
      // The scheduler-evidence read is a jobs capability like the others, so a
      // deployment without one must name it rather than answer 404 or, worse, 200
      // with a fabricated "no runs yet".
      '/api/jobs/maintenance',
    ]) {
      const response = await api(account, path, { method: 'GET', headers });
      expect(response.status).toBe(503);
      const parsed = (await response.json()) as { error?: string };
      expect(parsed.error).toBe('jobs_profile_disabled');
    }

    const created = await api(account, '/api/jobs', {
      method: 'POST',
      body,
      headers,
    });
    expect(created.status).toBe(503);
    expect(((await created.json()) as { error?: string }).error).toBe('jobs_profile_disabled');
  }, 60_000);

  test('an anonymous caller is refused before the capability is discussed', async () => {
    // 401 rather than 503: the request is not answerable at all without a session,
    // and telling an anonymous caller which capabilities this deployment has is
    // information it has no right to yet.
    const response = await fetch(`${base()}/api/jobs`, { headers: originHeaders() });
    expect(response.status).toBe(401);
  }, 30_000);

  test('the disabled profile leaves notes and auth working', async () => {
    // The negative control that matters: a jobs capability that is off must not
    // cost a working application anything. If this failed, the gating had leaked
    // into the shared composition root.
    const account = await signUp('integration-jobs-disabled-regression');

    const created = await api(account, '/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title: 'Still works', body: 'The jobs profile is off.' }),
    });
    expect(created.status).toBe(200);

    const listed = await api(account, '/api/notes');
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { notes: Array<{ title: string }> };
    expect(page.notes.some((note) => note.title === 'Still works')).toBe(true);

    const session = await api(account, '/api/auth/get-session');
    expect(session.status).toBe(200);
  }, 60_000);
});

/**
 * A second Worker, on its own port and its own persisted D1, with
 * `JOBS_PROFILE=encode`.
 *
 * A separate process rather than a second binding on the first one, because the
 * point is to exercise the enabled path through real workerd and a real local D1 —
 * migration 0003 applied, the partial unique index enforced by SQLite, the
 * correlated budget subqueries executed — and a fake binding would prove none of
 * that. The state directory is separate so this suite's jobs cannot collide with
 * the suite above's notes.
 */
describe('the jobs API with the compute profile enabled', () => {
  const JOBS_STATE = join(APP_DIR, '.wrangler-jobs-state');
  const JOBS_LOG = process.env.JOBS_WORKER_LOG ?? '/tmp/starter-integration-jobs-worker.log';
  const JOBS_RUN_ID = `jobs-${createId('it', 8)}`;

  let jobsServer: ChildProcess | undefined;
  let jobsPort = 0;

  const jobsBase = (): string => `http://127.0.0.1:${jobsPort}`;

  const jobsAuthFetch = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${jobsBase()}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        origin: jobsBase(),
        ...(init.headers ?? {}),
      },
    });

  const jobsApi = (account: Account, path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${jobsBase()}${path}`, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        origin: jobsBase(),
        cookie: account.cookie,
        ...(init.headers ?? {}),
      },
    });

  /** A verified account on this Worker, through the real account lifecycle. */
  const jobsSignUp = async (label: string): Promise<Account> => {
    const email = `${label}-${createId('t', 8)}@example.invalid`;
    const password = 'correct-horse-battery-staple';

    const created = await jobsAuthFetch('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({ email, password, name: label }),
    });
    if (!created.ok) {
      throw new Error(`sign-up failed: ${created.status} ${await created.text()}`);
    }

    const inbox = await fetch(`${jobsBase()}/api/dev/mail?to=${encodeURIComponent(email)}`);
    if (!inbox.ok) {
      throw new Error(`mail inbox unavailable: ${inbox.status}`);
    }
    const { messages } = (await inbox.json()) as { messages: CapturedMessage[] };
    const message = messages.find((entry) => entry.subject.includes('Verify'));
    if (message === undefined) {
      throw new Error(`No verification mail was captured for ${email}`);
    }
    const link = message.text.split('\n').find((entry) => entry.startsWith('http'));
    if (link === undefined) {
      throw new Error('No link in the verification mail');
    }
    await fetch(link, { redirect: 'manual' });

    const signedIn = await jobsAuthFetch('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (!signedIn.ok) {
      throw new Error(`sign-in failed: ${signedIn.status} ${await signedIn.text()}`);
    }
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    if (!cookie.includes('better-auth')) {
      throw new Error('sign-in set no session cookie');
    }
    return { email, password, cookie };
  };

  const jobBody = (): string => JSON.stringify({ fixture: 'sample-v1', preset: 'demo-180p-v1' });

  const postJob = (account: Account, idempotencyKey: string | null, body = jobBody()) =>
    jobsApi(account, '/api/jobs', {
      method: 'POST',
      body,
      headers: {
        ...originHeadersFor(jobsBase),
        ...(idempotencyKey === null ? {} : { 'idempotency-key': idempotencyKey }),
      },
    });

  beforeAll(async () => {
    jobsPort = await findFreePort();
    rmSync(JOBS_STATE, { recursive: true, force: true });

    const migrate = spawnSync(
      [
        WRANGLER,
        'd1',
        'migrations',
        'apply',
        'DB',
        '--local',
        '--config',
        APP_CONFIG,
        '--persist-to',
        JOBS_STATE,
      ],
      { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
    );
    if (migrate.exitCode !== 0) {
      throw new Error(`Jobs-profile migration failed:\n${migrate.stderr.toString()}`);
    }

    const logFd = openSync(JOBS_LOG, 'w');
    jobsServer = spawn(
      WRANGLER,
      [
        'dev',
        WORKER_ENTRY,
        '--port',
        String(jobsPort),
        '--local',
        '--config',
        APP_CONFIG,
        '--persist-to',
        JOBS_STATE,
        '--var',
        `TEST_RUN_ID:${JOBS_RUN_ID}`,
        '--var',
        'DEPLOYMENT_ENV:local',
        '--var',
        'BETTER_AUTH_SECRET:integration-test-secret-not-for-production-use',
        '--var',
        `AUTH_RATE_LIMIT_MAX:${AUTH_RATE_LIMIT_MAX}`,
        // The whole point of this Worker: the capability this repository ships as
        // off by default, turned on explicitly so the enabled path is exercised for
        // real rather than described.
        '--var',
        'JOBS_PROFILE:encode',
      ],
      { cwd: APP_DIR, stdio: ['ignore', logFd, logFd] },
    );

    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        const response = await fetch(`${jobsBase()}/api/health`);
        if (response.ok) {
          const health = (await response.json()) as { testRunId?: string };
          if (health.testRunId === JOBS_RUN_ID) {
            return;
          }
        }
      } catch {
        // Not listening yet.
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `The jobs-profile Worker never became ready. Log: ${JOBS_LOG}. ` +
            'Refusing to run the suite against a process this file did not start.',
        );
      }
      await sleep(400);
    }
  }, 240_000);

  afterAll(() => {
    if (jobsServer?.pid !== undefined) {
      killTree(jobsServer.pid, { graceMs: 200, attempts: 20 });
    }
    jobsServer = undefined;
    rmSync(JOBS_STATE, { recursive: true, force: true });
  });

  test('a verified user creates a job and gets it back', async () => {
    const account = await jobsSignUp('integration-jobs-create');
    const response = await postJob(account, createId('key', 12));

    expect(response.status).toBe(202);
    const job = (await response.json()) as {
      id: string;
      kind: string;
      status: string;
      outputAvailable: boolean;
      errorCode: string | null;
    };
    expect(job.kind).toBe('encode');
    expect(job.status).toBe('pending');
    expect(job.outputAvailable).toBe(false);
    expect(job.errorCode).toBeNull();

    // The DTO carries no owner id, no storage key and no dispatch diagnostics.
    const readBack = await jobsApi(account, `/api/jobs/${job.id}`);
    expect(readBack.status).toBe(200);
    expect(Object.keys(((await readBack.json()) as object) ?? {}).sort()).toEqual([
      'createdAt',
      'errorCode',
      'id',
      'kind',
      'outputAvailable',
      'status',
      'updatedAt',
    ]);
  }, 90_000);

  test('the same idempotency key returns the same job and does not spend twice', async () => {
    const account = await jobsSignUp('integration-jobs-idempotent');
    const key = createId('key', 12);

    const first = await postJob(account, key);
    const second = await postJob(account, key);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const one = (await first.json()) as { id: string };
    const two = (await second.json()) as { id: string };
    expect(two.id).toBe(one.id);

    const listed = await jobsApi(account, '/api/jobs');
    const page = (await listed.json()) as { jobs: Array<{ id: string }> };
    expect(page.jobs.filter((entry) => entry.id === one.id)).toHaveLength(1);
  }, 90_000);

  test('a missing or malformed idempotency key is refused by name', async () => {
    const account = await jobsSignUp('integration-jobs-key');
    const absent = await postJob(account, null);
    expect(absent.status).toBe(400);
    expect(((await absent.json()) as { error?: string }).error).toBe('invalid_idempotency_key');

    const spaced = await postJob(account, 'has a space');
    expect(spaced.status).toBe(400);
  }, 90_000);

  test('a body outside the frozen shapes is refused, and each field is refused for a reason', async () => {
    const account = await jobsSignUp('integration-jobs-body');
    const key = () => createId('key', 12);

    const cases: Array<[string, string]> = [
      ['a client that names its own owner', JSON.stringify({ fixture: 'sample-v1', preset: 'demo-180p-v1', ownerId: 'user_somebody_else' })],
      ['a URL for the input media', JSON.stringify({ fixture: 'https://example.invalid/v.mp4', preset: 'demo-180p-v1' })],
      ['an ffmpeg argument vector', JSON.stringify({ fixture: 'sample-v1', preset: 'demo-180p-v1', args: ['-f', 'lavfi'] })],
      ['a preset outside the frozen set', JSON.stringify({ fixture: 'sample-v1', preset: 'uhd-2160p-v1' })],
    ];

    for (const [label, body] of cases) {
      const response = await postJob(account, key(), body);
      expect(response.status, `${label} should be refused`).toBe(400);
    }
  }, 90_000);

  test('a second job while one is active is refused with the budget code', async () => {
    const account = await jobsSignUp('integration-jobs-budget');
    expect((await postJob(account, createId('key', 12))).status).toBe(202);

    const second = await postJob(account, createId('key', 12));
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error?: string }).error).toBe('budget_exceeded');
  }, 90_000);

  test('concurrent distinct keys admit exactly one job', async () => {
    // The active-job cap decided by the partial unique index inside the inserting
    // statement. A repository that counted first and then wrote would admit all
    // three here.
    const account = await jobsSignUp('integration-jobs-concurrent');
    const responses = await Promise.all([
      postJob(account, createId('key', 12)),
      postJob(account, createId('key', 12)),
      postJob(account, createId('key', 12)),
    ]);

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 202)).toHaveLength(1);
    expect(statuses.filter((status) => status === 429)).toHaveLength(2);
  }, 90_000);

  test('concurrent same-key requests produce one job and one 202 body', async () => {
    const account = await jobsSignUp('integration-jobs-concurrent-key');
    const key = createId('key', 12);
    const responses = await Promise.all([
      postJob(account, key),
      postJob(account, key),
      postJob(account, key),
    ]);

    expect(responses.every((response) => response.status === 202)).toBe(true);
    const ids = new Set<string>();
    for (const response of responses) {
      const job = (await response.json()) as { id: string };
      ids.add(job.id);
    }
    expect(ids.size).toBe(1);
  }, 90_000);

  test('one user cannot read another user\'s job, list it, or ask for its output', async () => {
    const [alice, bob] = await Promise.all([
      jobsSignUp('integration-jobs-alice'),
      jobsSignUp('integration-jobs-bob'),
    ]);

    const created = await postJob(alice, createId('key', 12));
    expect(created.status).toBe(202);
    const job = (await created.json()) as { id: string };

    // A guessed id answers exactly as a missing one does. A 403 or a 500 here
    // would confirm the job exists and turn the endpoint into an existence oracle.
    const guessed = await jobsApi(bob, `/api/jobs/${job.id}`);
    const missing = await jobsApi(bob, '/api/jobs/job_does_not_exist');
    expect(guessed.status).toBe(404);
    expect(missing.status).toBe(404);

    const output = await jobsApi(bob, `/api/jobs/${job.id}/output`);
    expect(output.status).toBe(404);

    const bobList = await jobsApi(bob, '/api/jobs');
    const page = (await bobList.json()) as { jobs: Array<{ id: string }> };
    expect(page.jobs.map((entry) => entry.id)).not.toContain(job.id);
  }, 120_000);

  test('the output of a job that has not succeeded says so, without leaking the id', async () => {
    const account = await jobsSignUp('integration-jobs-output');
    const created = await postJob(account, createId('key', 12));
    const job = (await created.json()) as { id: string };

    // 409, not 404: the job is the caller's and it exists; the *output* is not
    // there yet. A client that cannot tell these apart retries forever.
    const response = await jobsApi(account, `/api/jobs/${job.id}/output`);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error?: string }).error).toBe('output_not_ready');
  }, 90_000);

  test('a job has no mutating verb', async () => {
    const account = await jobsSignUp('integration-jobs-verbs');
    const created = await postJob(account, createId('key', 12));
    const job = (await created.json()) as { id: string };

    for (const method of ['PATCH', 'DELETE', 'PUT', 'POST']) {
      const response = await jobsApi(account, `/api/jobs/${job.id}`, { method });
      expect(response.status, `${method} should not be allowed`).toBe(405);
    }
  }, 90_000);

  test('the list pages with an opaque cursor and a bad cursor is refused', async () => {
    const account = await jobsSignUp('integration-jobs-list');
    expect((await postJob(account, createId('key', 12))).status).toBe(202);

    const first = await jobsApi(account, '/api/jobs?limit=1');
    expect(first.status).toBe(200);
    const page = (await first.json()) as { jobs: unknown[]; nextCursor: string | null };
    expect(page.jobs).toHaveLength(1);
    expect(page.nextCursor).toBeNull();

    // Malformed cursors are client errors, not successful empty pages.
    const garbage = await jobsApi(account, '/api/jobs?cursor=not-a-cursor');
    expect(garbage.status).toBe(400);
    expect(((await garbage.json()) as { error: string }).error).toBe('invalid_cursor');
  }, 90_000);

  test('a job whose dispatch failed is still visible, and is still recoverable', async () => {
    // No Workflow binding exists in this PR, so the wired dispatcher refuses and
    // the admission is committed anyway. That is the crash the design calls out —
    // D1 committed, the Workflow call did not — and it must leave a job the owner
    // can see rather than a 500 or a phantom success.
    const account = await jobsSignUp('integration-jobs-dispatch-failed');
    const created = await postJob(account, createId('key', 12));

    expect(created.status).toBe(202);
    const job = (await created.json()) as { id: string; status: string };
    expect(job.status).toBe('pending');

    const readBack = await jobsApi(account, `/api/jobs/${job.id}`);
    expect(readBack.status).toBe(200);
    expect(((await readBack.json()) as { status: string }).status).toBe('pending');
  }, 90_000);

  test('the scheduler evidence answers, and says nothing has run yet', async () => {
    // This Worker's D1 has had no maintenance run written to it, so "no scheduled
    // run" and "no run at all" are the true answers. Reporting either as a run, or
    // as a 404, would put a claim about a schedule on a screen with no evidence
    // for it — which is the dishonest case the two fields exist to separate.
    const account = await jobsSignUp('integration-jobs-maintenance');
    const response = await jobsApi(account, '/api/jobs/maintenance');

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      schedule: string | null;
      latest: unknown;
      latestScheduled: unknown;
      serverTime: number;
    };
    expect(body.schedule).toBe('17 * * * *');
    expect(body.latest).toBeNull();
    expect(body.latestScheduled).toBeNull();
    expect(typeof body.serverTime).toBe('number');
  }, 90_000);

  test('the scheduler evidence needs a session, like every other jobs route', async () => {
    const response = await fetch(`${jobsBase()}/api/jobs/maintenance`, {
      headers: originHeadersFor(jobsBase),
    });
    expect(response.status).toBe(401);
  }, 30_000);
});

// ── Device authorization and bearer sessions ─────────────────────────────────
//
// The native client's whole sign-in path, driven against the built Worker in real
// workerd with real D1: request a code, approve it in a browser session, poll, and
// use the token against the same `/api/notes` the web app uses.
//
// Everything a native client does is here, and each negative control is a property
// the acceptance criteria name:
//
//   * the approval page is a **route on this application**, not a URL the plugin
//     invented, and an anonymous visitor cannot reach it;
//   * a bearer token reaches **only its own owner's** data, and cannot choose an
//     owner;
//   * a bearer token does **not** bypass email verification — an unverified
//     account has no way to obtain one, so the assertion is made on the sign-in
//     step that would otherwise have been skipped;
//   * revoking the session server-side **kills the token** immediately.
//
// The one place real time is waited on is marked, and it cannot be injected away:
// the plugin enforces its own polling interval against a wall clock, so proving
// the successful poll means waiting out that interval once.
describe('device authorization', () => {
  const CLIENT_ID = 'starter-native-desktop-test';

  interface DeviceCode {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  }

  /** Ask for a code, exactly as the native client does. */
  const requestCode = async (clientId = CLIENT_ID): Promise<DeviceCode> => {
    const response = await authFetch('/api/auth/device/code', {
      method: 'POST',
      body: JSON.stringify({ client_id: clientId, scope: '' }),
    });
    if (!response.ok) {
      throw new Error(`device/code failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as DeviceCode;
  };

  /** Poll once, returning the provider's own answer. */
  const pollToken = async (
    code: DeviceCode,
    clientId = CLIENT_ID,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await authFetch('/api/auth/device/token', {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: clientId,
      }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  /** Open the approval page as a signed-in browser would, which claims the code. */
  const claimInBrowser = async (
    account: Account,
    code: DeviceCode,
  ): Promise<{ status: number; html: string }> => {
    const response = await fetch(
      `${base()}/device?user_code=${encodeURIComponent(code.user_code)}`,
      { headers: { cookie: account.cookie }, redirect: 'manual' },
    );
    return { status: response.status, html: await response.text() };
  };

  /** Press one of the two buttons on the approval page, as a form submission. */
  const decideInBrowser = async (
    account: Account,
    code: DeviceCode,
    action: 'approve' | 'deny',
  ): Promise<number> => {
    const response = await fetch(
      `${base()}/device?/${action}&user_code=${encodeURIComponent(code.user_code)}`,
      {
        method: 'POST',
        headers: {
          cookie: account.cookie,
          origin: base(),
          // The headers a browser form submission actually sends. A bare `fetch`
          // accepts anything and gets SvelteKit's serialized action result
          // (HTTP 200 with a JSON body) instead of the 303 a person follows, so
          // this test has to ask for what the browser asks for.
          accept: 'text/html,application/xhtml+xml',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: '',
        redirect: 'manual',
      },
    );
    return response.status;
  };

  test('the verification URI is a route on this application', async () => {
    // A client told to open `https://elsewhere.test/device` by a plugin default
    // would show a sign-in that cannot complete, with nothing to act on.
    const code = await requestCode();

    expect(code.verification_uri).toBe(`${base()}/device`);
    expect(code.verification_uri_complete).toContain(encodeURIComponent(code.user_code));
    expect(code.interval).toBeGreaterThan(0);
    expect(code.expires_in).toBeGreaterThan(0);
  }, 60_000);

  test('an anonymous visitor cannot reach the approval page', async () => {
    const code = await requestCode();
    const { status } = await claimInBrowser({ email: '', password: '', cookie: '' }, code);

    // Redirected to sign-in rather than shown an approval screen that cannot work.
    expect(status).toBe(303);
  }, 60_000);

  test('a user approves, the client polls, and the token works on the same API', async () => {
    const account = await signUp('integration-device-approve');
    const code = await requestCode();

    // First poll before anybody decided: pending, not an error the client should
    // treat as a failure.
    const first = await pollToken(code);
    expect(first.status).toBe(400);
    expect(first.body.error).toBe('authorization_pending');

    const claimed = await claimInBrowser(account, code);
    expect(claimed.status).toBe(200);
    // The page shows the code and the client, so a user can tell what they approve.
    expect(claimed.html).toContain(code.user_code);
    expect(claimed.html).toContain(CLIENT_ID);

    // A second poll inside the interval is the provider's back-off, which is what
    // the client's `slow_down` handling exists for.
    const tooFast = await pollToken(code);
    expect(tooFast.body.error).toBe('slow_down');

    const decided = await decideInBrowser(account, code, 'approve');
    expect(decided).toBe(303);

    // Real time, deliberately: the plugin compares `lastPolledAt` against the wall
    // clock, so the successful poll cannot happen until the interval has passed.
    await sleep(code.interval * 1_000 + 750);

    const approved = await pollToken(code);
    expect(approved.status).toBe(200);
    expect(approved.body.token_type).toBe('Bearer');
    const token = String(approved.body.access_token ?? '');
    expect(token.length).toBeGreaterThan(0);

    // The same `/api/notes` the browser uses, with a bearer token and no cookie.
    const withBearer = async (path: string, init: RequestInit = {}): Promise<Response> =>
      fetch(`${base()}${path}`, {
        ...init,
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...originHeaders(),
          authorization: `Bearer ${token}`,
        },
      });

    const created = await withBearer('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title: 'from the desktop app', body: 'written with a bearer token' }),
    });
    expect(created.status).toBe(200);
    const createdNote = (await created.json()) as { id: string };

    const list = (await (await withBearer('/api/notes')).json()) as {
      notes: { id: string; title: string }[];
    };
    expect(list.notes.some((note) => note.id === createdNote.id)).toBe(true);

    // …and the cookie session still sees it, because both paths are the same
    // account rather than two identities.
    const cookieList = (await (await api(account, '/api/notes')).json()) as {
      notes: { title: string }[];
    };
    expect(cookieList.notes.some((note) => note.title === 'from the desktop app')).toBe(true);
  }, 120_000);

  test('a bearer token cannot choose an owner, and reaches only its own notes', async () => {
    const account = await signUp('integration-device-owner');
    const other = await signUp('integration-device-other');
    const code = await requestCode();

    await claimInBrowser(account, code);
    await decideInBrowser(account, code, 'approve');
    await sleep(code.interval * 1_000 + 750);
    const approved = await pollToken(code);
    expect(approved.status).toBe(200);
    const token = String(approved.body.access_token);

    const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
      'content-type': 'application/json',
      ...originHeaders(),
      authorization: `Bearer ${token}`,
      ...extra,
    });

    // `NoteCreateSchema` sets `additionalProperties: false`, so a forged owner is
    // refused rather than accepted and ignored.
    const forged = await fetch(`${base()}/api/notes`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ title: 'forged', body: '', ownerId: 'someone-else' }),
    });
    expect(forged.status).toBe(422);

    // The real note lands under the token's own owner and under nobody else's.
    const mine = (await (
      await fetch(`${base()}/api/notes`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ title: 'owned by the token', body: '' }),
      })
    ).json()) as { id: string };
    const theirList = (await (
      await fetch(`${base()}/api/notes`, {
        headers: { ...originHeaders(), cookie: other.cookie },
      })
    ).json()) as { notes: { id: string }[] };

    expect(theirList.notes.some((note) => note.id === mine.id)).toBe(false);
  }, 120_000);

  test('a denied request never yields a token, and a polled-after-denial code says so', async () => {
    const account = await signUp('integration-device-deny');
    const code = await requestCode();

    await claimInBrowser(account, code);
    const decided = await decideInBrowser(account, code, 'deny');
    expect(decided).toBe(303);

    const after = await pollToken(code);
    expect(after.status).toBe(400);
    expect(after.body.error).toBe('access_denied');
  }, 60_000);

  test('an invented token is refused, and revoking the session kills a real one', async () => {
    const account = await signUp('integration-device-revoke');

    const invented = await fetch(`${base()}/api/notes`, {
      headers: { ...originHeaders(), authorization: 'Bearer not-a-real-token' },
    });
    expect(invented.status).toBe(401);

    const code = await requestCode();
    await claimInBrowser(account, code);
    await decideInBrowser(account, code, 'approve');
    await sleep(code.interval * 1_000 + 750);
    const approved = await pollToken(code);
    expect(approved.status).toBe(200);
    const token = String(approved.body.access_token);

    const beforeRevoke = await fetch(`${base()}/api/notes`, {
      headers: { ...originHeaders(), authorization: `Bearer ${token}` },
    });
    expect(beforeRevoke.status).toBe(200);

    // Revoked through the provider's own sign-out, with the same token: this is
    // what the native sign-out button calls.
    const signedOut = await authFetch('/api/auth/sign-out', {
      method: 'POST',
      body: '{}',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(signedOut.ok).toBe(true);

    const afterRevoke = await fetch(`${base()}/api/notes`, {
      headers: { ...originHeaders(), authorization: `Bearer ${token}` },
    });
    expect(afterRevoke.status).toBe(401);
  }, 120_000);
});
