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
import { fileURLToPath } from 'node:url';
import { createId } from '@starter/utils';
import { killTree } from '@starter/utils/process';
import { MAX_BODY_BYTES } from '../src/lib/server/telemetry_service.ts';

// `import.meta.url` is this file's URL: four levels up from
// apps/frontend/client/tests/ reaches the repository root.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
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

const signUp = async (label: string): Promise<Account> => {
  const email = `${label}-${createId('t', 8)}@example.invalid`;
  const password = 'correct-horse-battery-staple';

  const response = await fetch(`${base()}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...originHeaders() },
    body: JSON.stringify({ email, password, name: label }),
  });

  if (!response.ok) {
    throw new Error(
      `sign-up failed: ${response.status} ${await response.text()} (worker log: ${WORKER_LOG})`,
    );
  }

  const setCookie = response.headers.get('set-cookie') ?? '';
  return { email, password, cookie: setCookie.split(';')[0] ?? '' };
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
    const response = await fetch(`${base()}/login`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('auth-form');
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
    const response = await fetch(`${base()}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...originHeaders() },
      body: JSON.stringify({ email: account.email, password: 'wrong-password-entirely' }),
    });
    expect(response.ok).toBe(false);
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
