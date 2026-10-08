import { afterAll, beforeAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createId } from '@starter/utils';
import { killTree } from '@starter/utils/process';
import { sleep, spawn } from 'bun';
import { REPO_ROOT } from '../../../../scripts/src/shared/paths.ts';

const APP_DIR = join(REPO_ROOT, 'apps/frontend/client');
const RUN_ID = `worker-${createId('it', 8)}`;
const RUN_ROOT = join(REPO_ROOT, '.wrangler', 'runs', RUN_ID);
const LOG = join(RUN_ROOT, 'worker.log');
const WRANGLER = join(APP_DIR, 'node_modules/.bin/wrangler');
const VARS = process.env.STARTER_DEV_VARS_PATH;
if (!VARS) {
  throw new Error('STARTER_DEV_VARS_PATH is required by the Supabase Worker harness.');
}
const vars = Object.fromEntries(
  readFileSync(VARS, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const split = line.indexOf('=');
      return [line.slice(0, split), JSON.parse(line.slice(split + 1)) as string];
    }),
);
const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = vars.SUPABASE_SERVICE_ROLE_KEY as string | undefined;
if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  throw new Error('Supabase worker credentials are incomplete.');
}

let server: ReturnType<typeof spawn> | undefined;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const authHeaders = (cookies: string) => ({ cookie: cookies, origin: base() });

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        return reject(new Error('Could not allocate a Worker port.'));
      }
      probe.close(() => resolve(address.port));
    });
  });

const createAccount = async () => {
  const email = `cutover-${crypto.randomUUID()}@example.test`;
  const password = 'correct horse battery staple';
  const created = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: 'Cutover User' },
    }),
  });
  expect(created.status).toBe(200);
  const response = await fetch(`${base()}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base(), apikey: anonKey },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  const cookies = response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  expect(cookies).not.toBe('');
  const user = ((await response.json()) as { user: { id: string } }).user;
  expect(user.id).toMatch(/^[0-9a-f-]{36}$/i);
  return { cookies, id: user.id };
};

beforeAll(async () => {
  if (!existsSync(WRANGLER)) {
    throw new Error(`Missing pinned Wrangler at ${WRANGLER}.`);
  }
  const entry = join(APP_DIR, '.svelte-kit/cloudflare/_worker.js');
  if (!existsSync(entry)) {
    throw new Error(`Missing built Worker ${entry}; run bun run build first.`);
  }
  mkdirSync(RUN_ROOT, { recursive: true });
  rmSync(join(APP_DIR, '.svelte-kit/output/server'), { recursive: true, force: true });
  port = await freePort();
  const fd = openSync(LOG, 'w');
  server = spawn(
    [
      WRANGLER,
      'dev',
      entry,
      '--port',
      String(port),
      '--local',
      '--config',
      join(APP_DIR, 'wrangler.jsonc'),
      '--persist-to',
      join(RUN_ROOT, 'state'),
      '--env-file',
      VARS,
      '--var',
      `TEST_RUN_ID:${RUN_ID}`,
      '--var',
      'DEPLOYMENT_ENV:local',
    ],
    {
      cwd: APP_DIR,
      stdio: ['ignore', fd, fd],
    },
  );
  closeSync(fd);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base()}/api/health`);
      if (response.ok && ((await response.json()) as { testRunId?: string }).testRunId === RUN_ID) {
        return;
      }
    } catch {
      /* the Worker is still starting */
    }
    await sleep(200);
  }
  throw new Error(`Built Worker did not become ready. Log: ${LOG}`);
}, 90_000);

afterAll(() => {
  if (server?.pid !== undefined) {
    killTree(server.pid, { graceMs: 200, attempts: 20 });
  }
  server = undefined;
});

test('the real built Worker serves the run that started it', async () => {
  const response = await fetch(`${base()}/api/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ testRunId: RUN_ID });
});

test('Supabase sessions are UUID identities and notes stay owner scoped', async () => {
  const [first, second] = await Promise.all([createAccount(), createAccount()]);
  const created = await fetch(`${base()}/api/notes`, {
    method: 'POST',
    headers: { ...authHeaders(first.cookies), 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'private note', body: 'owner one' }),
  });
  expect(created.status).toBe(200);
  expect(((await created.json()) as { ownerId: string }).ownerId).toBe(first.id);
  const own = await fetch(`${base()}/api/notes`, { headers: authHeaders(first.cookies) });
  const other = await fetch(`${base()}/api/notes`, { headers: authHeaders(second.cookies) });
  expect(await own.text()).toContain('private note');
  expect(await other.text()).not.toContain('private note');
});

test('a legacy auth bearer token does not authenticate', async () => {
  const response = await fetch(`${base()}/api/notes`, {
    headers: { authorization: 'Bearer legacy_better_auth_session_token' },
  });
  expect(response.status).toBe(401);
});

test('disabled compute is reported as an explicit capability response', async () => {
  const account = await createAccount();
  const response = await fetch(`${base()}/api/jobs`, {
    method: 'POST',
    headers: {
      ...authHeaders(account.cookies),
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({ fixture: 'sample-v1', preset: 'demo-180p-v1' }),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: 'jobs_profile_disabled' });
});
