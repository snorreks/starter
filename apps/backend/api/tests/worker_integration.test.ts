// apps/backend/api/tests/worker_integration.test.ts
//
// Worker integration test against the real local runtime.
//
// This drives `wrangler dev` — the actual Workers runtime, with its own
// isolated local D1 — over real HTTP. It is not a mocked router: the Elysia app,
// Better Auth, Drizzle and D1 are all genuinely involved.
//
// Why it looks like this: Elysia 1.4's in-process `app.handle()` returns 404
// unless the app is actually listening, so an in-process test would be testing
// nothing. Booting the real runtime is both the honest and the workable option.
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
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { openSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createId } from '@starter/utils';
import { MAX_BODY_BYTES } from '../src/lib/telemetry.ts';

// `import.meta.url` is the file's URL: four levels up from
// apps/backend/api/tests/ reaches the repository root.
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
const API_DIR = join(REPO_ROOT, 'apps/backend/api');
const API_CONFIG = join(API_DIR, 'wrangler.jsonc');
const LOCAL_STATE = join(API_DIR, '.wrangler/state');

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

type Readiness = { ready: boolean; reason: string };

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
  if (!existsSync(API_CONFIG)) {
    throw new Error(`Missing ${API_CONFIG}`);
  }

  port = await findFreePort();

  // Isolate the database: a stale local state would make "create" assertions
  // depend on whatever a previous run left behind.
  rmSync(LOCAL_STATE, { recursive: true, force: true });

  const migrate = Bun.spawnSync(
    ['bunx', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', API_CONFIG],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  if (migrate.exitCode !== 0) {
    throw new Error(`Migration failed:\n${migrate.stderr.toString()}`);
  }

  const logFd = openSync(WORKER_LOG, 'w');

  server = spawn(
    'bunx',
    [
      'wrangler', 'dev',
      '--port', String(port),
      '--local',
      '--config', API_CONFIG,
      '--var', `TEST_RUN_ID:${RUN_ID}`,
      // The sign-in rate limit is real and stays on. A test run creates an
      // account per case, which exceeds a production-sane per-minute budget, so
      // the budget is raised for the run rather than disabled — disabling it
      // would also stop this suite from exercising the limit's existence.
      '--var', `AUTH_RATE_LIMIT_MAX:${AUTH_RATE_LIMIT_MAX}`,
      '--var', 'BETTER_AUTH_SECRET:integration-test-secret-not-for-production-use',
    ],
    {
      cwd: API_DIR,
      // Captured rather than ignored: a Worker that throws answers 500 with an
      // empty body, and a swallowed log makes that undebuggable.
      stdio: ['ignore', logFd, logFd],
    },
  );

  const readiness = await waitForOurWorker();
  if (!readiness.ready) {
    server.kill('SIGKILL');
    throw new Error(readiness.reason);
  }
}, 240_000);

afterAll(() => {
  // Only ever the process this file started.
  server?.kill('SIGKILL');
});

// ── Helpers ──────────────────────────────────────────────────────────────────

type Account = { email: string; password: string; cookie: string };

const signUp = async (label: string): Promise<Account> => {
  const email = `${label}-${createId('t', 8)}@example.invalid`;
  const password = 'correct-horse-battery-staple';

  const response = await fetch(`${base()}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
      // Only when there is a body. Sending `content-type: application/json`
      // with no body makes the router attempt to parse an empty stream, and a
      // DELETE then fails with a 500 that has nothing to do with DELETE.
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
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
    const health = (await response.json()) as { ok: boolean; service: string; testRunId: string };
    expect(health.ok).toBe(true);
    expect(health.service).toBe('api');
    expect(health.testRunId).toBe(RUN_ID);
  });
});

describe('authentication', () => {
  test('rejects an anonymous read of the notes collection', async () => {
    const response = await fetch(`${base()}/api/notes`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  test('signs a user up and returns a session', async () => {
    const account = await signUp('integration');
    expect(account.cookie).toContain('better-auth');

    const whoami = await api(account, '/api/whoami');
    expect(whoami.status).toBe(200);
    const identity = (await whoami.json()) as { email: string };
    expect(identity.email).toBe(account.email);
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
      headers: { 'content-type': 'application/json' },
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
    // 422 from Elysia's body validation, not 500.
    expect([400, 422]).toContain(response.status);
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

  test('the owner id comes from the session, not the request body', async () => {
    const account = await signUp('integration-ownerid');
    const response = await api(account, '/api/notes', {
      method: 'POST',
      // `ownerId` is not in the create schema, so it must be refused outright.
      body: JSON.stringify({ title: 'Injected', body: '', ownerId: 'someone-else' }),
    });

    expect([400, 422]).toContain(response.status);
  });
});

describe('telemetry', () => {
  test('accepts a well-formed event and rejects a malformed one', async () => {
    const event = {
      timestamp: Date.now(),
      app: 'client',
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ not: 'a log event' }),
    });
    // 422: the router validates the body against the TypeBox schema, so a
    // malformed record is refused as a bad request rather than silently
    // accepted and dropped.
    expect(rejected.status).toBe(422);
  });

  test('refuses an oversized submission', async () => {
    const oversized = JSON.stringify({
      timestamp: Date.now(),
      app: 'client',
      environment: 'local',
      source: 'browser',
      level: 'INFO',
      event: 'big',
      release: 'test',
      message: 'x'.repeat(MAX_BODY_BYTES + 1024),
    });

    const response = await fetch(`${base()}/api/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    // 413 from the router's body limit, or 422 from validation if it got that
    // far. Either is a refusal; a 202 would mean it was stored.
    expect([413, 422]).toContain(response.status);
  });
});
