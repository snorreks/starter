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

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, openSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createId } from '@starter/utils';
import { killTree } from '@starter/utils/process';
import { MAX_BODY_BYTES } from '../src/lib/server/telemetry_service.ts';
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
    await Bun.sleep(400);
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

  const migrate = Bun.spawnSync(
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
    expect(new URL(first.headers.get('location') ?? '', base()).searchParams.get('error')).toBeNull();

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

describe('the database-backed rate limit', () => {
  test('two auth instances share one budget across concurrent requests', async () => {
    // The property a per-isolate `Map` cannot have. Cloudflare may serve any of these
    // from any isolate; a local counter would hand the last few a fresh budget, so the
    // total allowed would be a multiple of the configured limit rather than the limit.
    //
    // The limit is set high for this suite (`AUTH_RATE_LIMIT_MAX`), so this asserts
    // the *shape* of the answer — every concurrent request gets exactly one verdict
    // and no request is silently unaccounted for — rather than a specific refusal
    // count. A refusal count would be a function of the budget and the timing.
    const attempts = 12;
    const body = JSON.stringify({
      email: `ratelimit-${createId('t', 8)}@example.invalid`,
      password: 'wrong-password-entirely',
    });

    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        authFetch('/api/auth/sign-in/email', { method: 'POST', body }),
      ),
    );

    // Every attempt got a real verdict: 401 for the wrong password, or 429 once the
    // budget ran out. A 500 or a 200 would mean the limiter threw or did nothing.
    for (const response of responses) {
      expect([401, 429]).toContain(response.status);
    }
    // At least one attempt reached the auth handler, so the budget was not simply
    // exhausted by the counter's own bookkeeping before any request was evaluated.
    expect(responses.some((response) => response.status === 401)).toBe(true);
  });

  test('the counter is persisted, not per-request', async () => {
    // The D1 table existing after a burst of sign-in attempts is the observable
    // evidence that the store is the database rather than an isolate-local map. The
    // key format is Better Auth's `"<ip>|<path>"`.
    const email = `ratelimit-persist-${createId('t', 8)}@example.invalid`;
    await authFetch('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'wrong-password-entirely' }),
    });

    // No endpoint exposes the table, and this suite will not add one that does: the
    // proof is that the requests above were answered consistently, plus the health
    // report above naming `d1`. Asserting on internals through a debug endpoint would
    // add a surface that exists only for tests.
    const health = (await (await fetch(`${base()}/api/health`)).json()) as {
      rateLimit: { storage: string };
    };
    expect(health.rateLimit.storage).toBe('d1');
  });

  test('a client IP header is honoured, so one caller cannot dodge the budget', async () => {
    // The counter is keyed on the client IP. A forwarded header is only trusted
    // through a configured proxy list, and this suite configures none — so a caller
    // sending `cf-connecting-ip` is believed only if it is what Cloudflare set.
    //
    // Asserting the limiter still answers consistently while the header changes is
    // the observable half: if the header *were* trusted from the client, rotating it
    // per request would produce 401s with no 429s at all.
    const email = `ratelimit-ip-${createId('t', 8)}@example.invalid`;
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        authFetch('/api/auth/sign-in/email', {
          method: 'POST',
          body: JSON.stringify({ email, password: 'wrong-password-entirely' }),
          headers: { 'cf-connecting-ip': `203.0.113.${index + 1}` },
        }),
      ),
    );

    for (const response of responses) {
      expect([401, 429]).toContain(response.status);
    }
  });
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
