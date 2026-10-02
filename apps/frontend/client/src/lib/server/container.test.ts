// apps/frontend/client/src/lib/server/container.test.ts
//
// The composition root's container, and the 503 a caller observes when the
// configuration is bad.
//
// `env.test.ts` proves the decisions. This proves they are actually reached from
// the container, and — more importantly — what a caller observes when they are
// wrong. A configuration failure must be visible to whoever is deploying: the
// previous behaviour was to throw out of `fetch`, which workerd turned into a
// generic 500 whose body said nothing about which binding was missing. The symptom
// of that is a deploy that reports success and a site that 500s.
//
// The entrypoint itself (`src/hooks.server.ts`) is not imported here, and cannot
// be: it reads `cloudflare:workers`, which only exists inside the Worker runtime.
// Testing the container it delegates to keeps the same coverage without a second
// copy of the binding plumbing, and the 503 reaching a real caller over real HTTP
// is covered by `tests/worker_integration.test.ts`.
//
// The D1 binding here is a stub. Nothing here touches the database: the point is
// to reach the configuration decisions before any query happens.

import { describe, expect, test } from 'bun:test';
import { getContainer } from './container.ts';
import { notConfigured } from './http.ts';

/** A D1-shaped stub. The container only stores the handle; it never calls it. */
const dbStub = {} as unknown as D1Database;

const localEnv = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  DB: dbStub,
  DEPLOYMENT_ENV: 'local',
  BETTER_AUTH_URL: 'http://127.0.0.1:5173',
  ...overrides,
});

describe('the container refuses bad configuration with a named cause', () => {
  test('a missing D1 binding names the binding and the file to edit', () => {
    expect(() => getContainer({})).toThrow(/"DB"/);
    expect(() => getContainer({})).toThrow(/wrangler\.jsonc/);
  });

  test('a completely absent env object is refused', () => {
    expect(() => getContainer(undefined)).toThrow(/"DB"/);
  });

  // The defect this file exists for: no DEPLOYMENT_ENV used to mean local.
  test('an env with no DEPLOYMENT_ENV is refused, not treated as local', () => {
    const env = localEnv({ DEPLOYMENT_ENV: undefined, BETTER_AUTH_URL: undefined });
    expect(() => getContainer(env, 'http://127.0.0.1:5173')).toThrow(/DEPLOYMENT_ENV/);
  });

  test('a remote env carrying the development secret is refused', () => {
    const env = localEnv({
      DEPLOYMENT_ENV: 'production',
      BETTER_AUTH_URL: 'https://web.example.test',
      BETTER_AUTH_SECRET: 'development-only-not-a-secret',
    });

    expect(() => getContainer(env)).toThrow(/development placeholder/);
  });
});

describe('a valid env produces a container that names its own environment', () => {
  test('ordinary local startup reports local', () => {
    const container = getContainer(localEnv());
    expect(container.environment).toBe('local');
    expect(container.isLocal).toBe(true);
    expect(container.baseUrl).toBe('http://127.0.0.1:5173');
    expect(container.auth).toBeDefined();
  });

  test('a remote env with a real secret reports the resolved name, not a guess', () => {
    // Not `isLocal ? 'local' : 'production'` — the resolved name, so a
    // `development` deployment does not report itself as production.
    const container = getContainer(
      localEnv({
        DEPLOYMENT_ENV: 'production',
        BETTER_AUTH_URL: 'https://web.example.test',
        BETTER_AUTH_SECRET: 'z'.repeat(48),
      }),
    );
    expect(container.environment).toBe('production');
    expect(container.isLocal).toBe(false);
  });
});

describe('the container is memoized per binding set and origin, and never across them', () => {
  test('the same binding set and origin reuses one container', () => {
    const env = localEnv();
    expect(getContainer(env, 'http://127.0.0.1:5173')).toBe(
      getContainer(env, 'http://127.0.0.1:5173'),
    );
  });

  test('two origins on one binding set get two containers', () => {
    // The auth instance's `baseURL` is part of what a container is built from, so
    // sharing one across origins would hand a session cookie the wrong origin. In a
    // deployed Worker there is exactly one origin, so this level of the key never
    // holds more than one entry in production.
    const env = localEnv({ BETTER_AUTH_URL: undefined });
    const first = getContainer(env, 'http://127.0.0.1:6100');
    const second = getContainer(env, 'http://127.0.0.1:6200');
    expect(first).not.toBe(second);
    expect(first.baseUrl).toBe('http://127.0.0.1:6100');
    expect(second.baseUrl).toBe('http://127.0.0.1:6200');
  });

  test('two binding sets never share a container', () => {
    const local = localEnv();
    const staging = localEnv({
      DEPLOYMENT_ENV: 'staging',
      BETTER_AUTH_URL: 'https://staging.example.test',
      BETTER_AUTH_SECRET: 'q'.repeat(48),
    });

    const firstLocal = getContainer(local);
    const secondLocal = getContainer(local);
    const stagingContainer = getContainer(staging);

    expect(firstLocal).toBe(secondLocal);
    expect(stagingContainer).not.toBe(firstLocal);
    expect(stagingContainer.environment).toBe('staging');
  });
});

describe('a misconfigured deployment tells the caller what is wrong', () => {
  test('an API caller gets the shared error shape', async () => {
    const response = notConfigured('The D1 binding "DB" is not available.', true);
    expect(response.status).toBe(503);
    // The type argument is not decoration. `@cloudflare/workers-types` declares
    // `json<T>(): Promise<T>` and this program also has the DOM lib, whose
    // `json()` returns `Promise<any>`; the merged overload resolves to
    // `Promise<unknown>` with no inference site. Naming the shape is how the
    // assertion below gets a real type on both sides, and it is the same call a
    // route adapter would make if it read its own error body.
    const body = await response.json<{ error: string; message: string }>();
    expect(body).toEqual({
      error: 'not_configured',
      message: 'The D1 binding "DB" is not available.',
    });
  });

  test('a browser gets the same message as readable text', async () => {
    const response = notConfigured('The D1 binding "DB" is not available.', false);
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('DB');
  });
});
