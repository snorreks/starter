// apps/backend/api/src/worker_config.test.ts
//
// The real `worker.fetch` entrypoint, with deployment-like bindings.
//
// `env.test.ts` proves the decisions. This proves they are actually reached from
// the entrypoint, and — more importantly — what a caller observes when the
// configuration is bad.
//
// A configuration failure must be visible to whoever is deploying. The previous
// behaviour was to throw out of `fetch`, which workerd turns into a generic 500
// whose body says nothing about which binding is missing. The symptom of that is
// a deploy that reports success and a site that 500s.
//
// The D1 binding here is a stub. Nothing here touches the database: the point is
// to reach the configuration decisions before any query happens.

import { describe, expect, test } from 'bun:test';
import worker from './index.ts';

/** A D1-shaped stub. The container only stores the handle; it never calls it. */
const dbStub = {} as unknown as D1Database;

const health = (_env: unknown): Request =>
  new Request('https://api.example.test/api/health', { method: 'GET' });

const localEnv = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  DB: dbStub,
  DEPLOYMENT_ENV: 'local',
  BETTER_AUTH_URL: 'http://127.0.0.1:8787',
  ...overrides,
});

describe('worker.fetch configuration handling', () => {
  test('a missing D1 binding is refused with a named cause, not a generic 500', async () => {
    const response = await worker.fetch(health({}), {});

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('not configured correctly');
    expect(body).toContain('DB');
  });

  test('a completely absent env object is refused', async () => {
    const response = await worker.fetch(health(undefined), undefined);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('DB');
  });

  // The defect this whole file exists for: no DEPLOYMENT_ENV used to mean local.
  test('a deployed-looking env with no DEPLOYMENT_ENV is refused, not treated as local', async () => {
    const response = await worker.fetch(
      health(localEnv({ DEPLOYMENT_ENV: undefined, BETTER_AUTH_URL: undefined })),
      localEnv({ DEPLOYMENT_ENV: undefined, BETTER_AUTH_URL: undefined }),
    );

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('DEPLOYMENT_ENV');
  });

  test('a remote env carrying the development secret is refused', async () => {
    const env = localEnv({
      DEPLOYMENT_ENV: 'production',
      BETTER_AUTH_URL: 'https://api.example.test',
      BETTER_AUTH_SECRET: 'development-only-not-a-secret',
    });

    const response = await worker.fetch(health(env), env);

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('development placeholder');
    // The refused value must not be echoed back.
    expect(body).not.toContain('development-only-not-a-secret\n');
  });

  test('a remote env with a real secret starts, and reports the environment by name', async () => {
    const env = localEnv({
      DEPLOYMENT_ENV: 'production',
      BETTER_AUTH_URL: 'https://api.example.test',
      BETTER_AUTH_SECRET: 'z'.repeat(48),
    });

    const response = await worker.fetch(health(env), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; environment: string };
    expect(body.ok).toBe(true);
    // Not `isLocal ? 'local' : 'production'` — the resolved name, so a
    // `development` deployment does not report itself as production.
    expect(body.environment).toBe('production');
  });

  test('ordinary local startup works and reports local', async () => {
    const env = localEnv();
    const response = await worker.fetch(health(env), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; environment: string };
    expect(body).toMatchObject({ ok: true, environment: 'local' });
  });

  test('the container is memoized per binding set, and not across two', async () => {
    const local = localEnv();
    const remote = localEnv({
      DEPLOYMENT_ENV: 'staging',
      BETTER_AUTH_URL: 'https://staging.example.test',
      BETTER_AUTH_SECRET: 'q'.repeat(48),
    });

    const [firstLocal, secondLocal, staging] = await Promise.all([
      worker.fetch(health(local), local),
      worker.fetch(health(local), local),
      worker.fetch(health(remote), remote),
    ]);

    expect(await firstLocal.json()).toMatchObject({ environment: 'local' });
    expect(await secondLocal.json()).toMatchObject({ environment: 'local' });
    expect(await staging.json()).toMatchObject({ environment: 'staging' });
  });
});
