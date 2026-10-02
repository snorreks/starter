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
import { resolveTrustedOrigins } from './env.ts';
import { notConfigured } from './http.ts';

/** A D1-shaped stub. The container only stores the handle; it never calls it. */
const dbStub = {} as unknown as D1Database;

/**
 * A local environment. No mail configuration, and that is the point: local
 * captures into an in-memory inbox, so these tests never need a provider key and
 * never send anything.
 */
const localEnv = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  DB: dbStub,
  DEPLOYMENT_ENV: 'local',
  BETTER_AUTH_URL: 'http://127.0.0.1:5173',
  ...overrides,
});

/**
 * A deployed environment.
 *
 * Carries a complete mail configuration, because a remote one that lacks it is
 * refused — see the production cases below. Writing the key here rather than in
 * each test keeps the *absence* the deliberate change, which is what these tests
 * vary.
 */
const remoteEnv = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  DB: dbStub,
  DEPLOYMENT_ENV: 'production',
  BETTER_AUTH_URL: 'https://web.example.test',
  BETTER_AUTH_SECRET: 'z'.repeat(48),
  RESEND_API_KEY: 're_test_only_not_a_real_key',
  MAIL_FROM: 'Starter <no-reply@example.test>',
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
    expect(() =>
      getContainer(remoteEnv({ BETTER_AUTH_SECRET: 'development-only-not-a-secret' })),
    ).toThrow(/development placeholder/);
  });

  // The other half of a complete account lifecycle. A deployed Worker with no mail
  // transport would accept every sign-up, report them successful, and deliver
  // nothing — so the accounts exist and nobody can ever finish setting them up.
  test('a deployed env with no mail provider refuses to start', () => {
    expect(() => getContainer(remoteEnv({ RESEND_API_KEY: undefined }))).toThrow(/RESEND_API_KEY/);
  });

  test('a deployed env with no sender address refuses to start', () => {
    expect(() => getContainer(remoteEnv({ MAIL_FROM: undefined }))).toThrow(/MAIL_FROM/);
  });

  test('a deployed env cannot be talked into the local capture inbox', () => {
    // The tempting configuration: no key, and a Worker that quietly keeps messages
    // in memory. Nothing here has to look for it — the refusal is unconditional.
    expect(() => getContainer(remoteEnv({ RESEND_API_KEY: '   ' }))).toThrow(
      /not permitted to use the local capture inbox/,
    );
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
    const container = getContainer(remoteEnv());
    expect(container.environment).toBe('production');
    expect(container.isLocal).toBe(false);
  });

  test('a local env captures mail without a provider key', () => {
    // The property every test in this repository relies on: a local run can
    // exercise verification and recovery with no Resend account and no network.
    const container = getContainer(localEnv());
    expect(container.mail.mode).toBe('capture');
    expect(container.mailCapture).toBeDefined();
  });

  test('a deployed env delivers through Resend and exposes no inbox', () => {
    const container = getContainer(remoteEnv());

    // `mailCapture` is absent, not merely empty. A caller reaching for it gets
    // `undefined` and a type error, rather than an inbox that looks like a working
    // deployment and swallows every verification mail.
    expect(container.mail.mode).toBe('resend');
    expect(container.mailCapture).toBeUndefined();
  });

  test('a local env holding a stray provider key still captures', () => {
    // A developer with a real key in `.env` must not be able to mail strangers by
    // running `bun run dev`.
    expect(getContainer(localEnv({ RESEND_API_KEY: 're_live_real' })).mail.mode).toBe('capture');
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
    const staging = remoteEnv({
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

  test('two local runs sharing one D1 keep separate inboxes', () => {
    // The container is memoized per binding set, so two `TEST_RUN_ID`s on one
    // binding set share it — and the inbox id is read per container build. What
    // must not happen is one run reading another's messages, which the inbox id in
    // the `/api/dev/mail` response is what proves.
    const first = getContainer(localEnv({ TEST_RUN_ID: 'run-a' }));
    const second = getContainer(localEnv({ TEST_RUN_ID: 'run-b' }));

    expect(first.mailCapture).not.toBe(second.mailCapture);
    expect(first.env.TEST_RUN_ID).toBe('run-a');
    expect(second.env.TEST_RUN_ID).toBe('run-b');
  });
});

describe('the trusted-origin list accepts the origin the browser actually sends', () => {
  test('a local origin is accepted with and without its port', () => {
    // `wrangler dev` rewrites the inbound `Origin` header to drop the port before the
    // Worker sees it, while the browser sent the ported form. Trusting only one of
    // them makes every credentialed request fail with INVALID_ORIGIN — which is
    // exactly what happened to the E2E lane before this was handled.
    const origins = resolveTrustedOrigins({}, 'http://127.0.0.1:4183', true);

    expect(origins).toContain('http://127.0.0.1:4183');
    expect(origins).toContain('http://127.0.0.1');
  });

  test('the portless form is not added when it would be a duplicate', () => {
    const origins = resolveTrustedOrigins({}, 'http://localhost', true);
    expect(origins.filter((origin) => origin === 'http://localhost')).toHaveLength(1);
  });

  test('a remote deployment gets no portless variant', () => {
    // In production there is one hostname. Inventing a second acceptable origin there
    // would widen the allowlist rather than correct a mismatch.
    const origins = resolveTrustedOrigins({}, 'https://web.example.test', false);

    expect(origins).toEqual(['https://web.example.test']);
  });

  test('configured origins are kept, and duplicates collapse', () => {
    const origins = resolveTrustedOrigins(
      { TRUSTED_ORIGINS: 'https://a.example.test, https://b.example.test' },
      'https://a.example.test',
      false,
    );

    expect(origins).toEqual(['https://a.example.test', 'https://b.example.test']);
  });

  test('a configured origin is never dropped, only added to', () => {
    // A second trusted origin is a deliberate operator choice; this must never
    // quietly remove it.
    const origins = resolveTrustedOrigins(
      { TRUSTED_ORIGINS: 'https://other.example.test' },
      'https://web.example.test',
      false,
    );

    expect(origins).toContain('https://other.example.test');
    expect(origins).toContain('https://web.example.test');
  });

  test('a container built from a local env trusts the portless origin too', () => {
    // End to end through the container, because the list is only correct if it
    // actually reaches the auth instance.
    const container = getContainer(localEnv({ BETTER_AUTH_URL: 'http://127.0.0.1:6100' }));
    expect(container.baseUrl).toBe('http://127.0.0.1:6100');
    // `container.auth.options.trustedOrigins` is the list Better Auth checks against.
    const trusted = container.auth.options.trustedOrigins as string[] | undefined;
    expect(trusted ?? []).toContain('http://127.0.0.1:6100');
    expect(trusted ?? []).toContain('http://127.0.0.1');
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
