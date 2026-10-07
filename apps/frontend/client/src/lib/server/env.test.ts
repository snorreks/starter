// apps/frontend/client/src/lib/server/env.test.ts
//
// Deployment-mode resolution, public-origin resolution and auth-secret resolution.
//
// These are the decisions that decide whether a deployed Worker is allowed to run
// with a development auth secret, and the defect they cover was reachable from a
// plain misconfiguration:
//
//   const isLocal = env.BETTER_AUTH_URL === undefined || env.BETTER_AUTH_URL.includes('localhost');
//
// A Worker deployed without `BETTER_AUTH_URL` — the single most likely binding to
// be missing — satisfied the first clause, was classified local, and got the
// shipped secret. `https://attacker-localhost.example` satisfied the second.
//
// The origin derivation added by the single-Worker migration gets the same
// treatment, and for the same reason: it is the one place where a request
// influences configuration, so the cases where it must refuse are worth more than
// the case where it succeeds.
//
// These are pure functions over a binding-shaped object, so they are tested here
// rather than through workerd. The entrypoint behaviour that consumes them is
// covered by `tests/worker_integration.test.ts` and by
// `src/lib/server/container.test.ts`.

import { describe, expect, test } from 'bun:test';
import {
  type AppEnv,
  AUTH_SECRET_PLACEHOLDER,
  parseAbsoluteHttpUrl,
  requireBindings,
  resolveAuthSecret,
  resolveBackendProfile,
  resolveDeploymentEnvironment,
} from './env.ts';

/** A binding set with only the fields a decision here depends on. */
const bindings = (overrides: Partial<AppEnv> = {}): AppEnv =>
  ({
    DB: {} as unknown as D1Database,
    DEPLOYMENT_ENV: 'local',
    BETTER_AUTH_URL: 'http://127.0.0.1:5173',
    ...overrides,
  }) as AppEnv;

describe('resolveDeploymentEnvironment', () => {
  test('a missing DEPLOYMENT_ENV is an error, not a local default', () => {
    const result = resolveDeploymentEnvironment({ BETTER_AUTH_URL: 'https://web.example.com' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.problem).toContain('DEPLOYMENT_ENV');
  });

  test('an empty DEPLOYMENT_ENV is an error', () => {
    const result = resolveDeploymentEnvironment({
      DEPLOYMENT_ENV: '   ',
      BETTER_AUTH_URL: 'https://web.example.com',
    });
    expect(result.ok).toBe(false);
  });

  test('an unrecognised DEPLOYMENT_ENV is an error, not a local default', () => {
    const result = resolveDeploymentEnvironment({
      DEPLOYMENT_ENV: 'prod',
      BETTER_AUTH_URL: 'https://web.example.com',
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.remedy).toContain('production');
  });

  test('local resolves to local and reports the configured origin', () => {
    const result = resolveDeploymentEnvironment({
      DEPLOYMENT_ENV: 'local',
      BETTER_AUTH_URL: 'http://127.0.0.1:5173',
    });
    expect(result).toEqual({
      ok: true,
      environment: 'local',
      isLocal: true,
      baseUrl: 'http://127.0.0.1:5173',
    });
  });

  test.each(['staging', 'production'])('%s resolves to a remote environment', (environment) => {
    const result = resolveDeploymentEnvironment({
      DEPLOYMENT_ENV: environment,
      BETTER_AUTH_URL: 'https://web.example.com',
    });
    expect(result).toEqual({
      ok: true,
      environment,
      isLocal: false,
      baseUrl: 'https://web.example.com',
    });
  });

  test('a remote environment without BETTER_AUTH_URL fails', () => {
    const result = resolveDeploymentEnvironment({ DEPLOYMENT_ENV: 'production' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.problem).toContain('BETTER_AUTH_URL');
  });

  test('a remote environment over plain http fails', () => {
    const result = resolveDeploymentEnvironment({
      DEPLOYMENT_ENV: 'production',
      BETTER_AUTH_URL: 'http://web.example.com',
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.problem).toContain('https');
  });

  // The specific shape that defeated the substring heuristic: a real-looking
  // remote hostname that merely *contains* "localhost".
  test.each([
    'https://not-localhost.example.com',
    'https://localhost.attacker.example',
    'https://mylocalhostdev.example',
  ])('a remote hostname containing "localhost" is remote, not local: %s', (url) => {
    const result = resolveDeploymentEnvironment({
      DEPLOYMENT_ENV: 'production',
      BETTER_AUTH_URL: url,
    });
    expect(result).toEqual({
      ok: true,
      environment: 'production',
      isLocal: false,
      baseUrl: url,
    });
  });

  test.each(['not-a-url', 'ftp://example.com', '//example.com', 'https://'])(
    'a malformed BETTER_AUTH_URL is rejected: %s',
    (url) => {
      const result = resolveDeploymentEnvironment({
        DEPLOYMENT_ENV: 'local',
        BETTER_AUTH_URL: url,
      });
      expect(result.ok).toBe(false);
    },
  );
});

describe('the local public origin is derived from the request, and only then', () => {
  test('a local run with no BETTER_AUTH_URL uses the request origin', () => {
    // This is the case the migration depends on. One origin serves the HTML and
    // the API, so a value that has to be edited whenever the dev port changes is
    // a value that will be wrong the first time two checkouts run at once.
    const result = resolveDeploymentEnvironment(
      { DEPLOYMENT_ENV: 'local' },
      'http://127.0.0.1:6100',
    );
    expect(result).toEqual({
      ok: true,
      environment: 'local',
      isLocal: true,
      baseUrl: 'http://127.0.0.1:6100',
    });
  });

  test('an explicit BETTER_AUTH_URL still wins over the request origin', () => {
    const result = resolveDeploymentEnvironment(
      { DEPLOYMENT_ENV: 'local', BETTER_AUTH_URL: 'http://localhost:5173' },
      'http://127.0.0.1:6100',
    );
    expect(result.ok && result.baseUrl).toBe('http://localhost:5173');
  });

  test('a non-loopback request origin is refused, so a caller cannot choose the origin', () => {
    // The one hole derivation could open. Locality is still never inferred from a
    // URL — DEPLOYMENT_ENV had to be set — but without the loopback check a
    // deployment left on `DEPLOYMENT_ENV=local` would hand its auth configuration
    // to whatever origin reached it.
    for (const origin of [
      'https://web.example.com',
      'http://10.0.0.5:5173',
      'https://localhost:5173',
    ]) {
      const result = resolveDeploymentEnvironment({ DEPLOYMENT_ENV: 'local' }, origin);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('unreachable');
      }
      expect(result.problem).toContain('loopback');
    }
  });

  test('https on loopback is refused too: the local dev server is http', () => {
    const result = resolveDeploymentEnvironment(
      { DEPLOYMENT_ENV: 'local' },
      'https://127.0.0.1:5173',
    );
    expect(result.ok).toBe(false);
  });

  test('a local run with neither a configured nor a derivable origin fails closed', () => {
    // The build and prerender stages reach this: there is a request but no origin
    // to take one from. Refusing is correct — a container with a guessed base URL
    // would issue session cookies for an origin the user never visited.
    const result = resolveDeploymentEnvironment({ DEPLOYMENT_ENV: 'local' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.problem).toContain('origin');
  });

  test('a remote environment never derives an origin from the request', () => {
    const result = resolveDeploymentEnvironment(
      { DEPLOYMENT_ENV: 'production' },
      'http://127.0.0.1:5173',
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.problem).toContain('BETTER_AUTH_URL');
  });
});

describe('resolveAuthSecret', () => {
  test('local with no secret gets the development placeholder', () => {
    expect(resolveAuthSecret(bindings(), true)).toBe(AUTH_SECRET_PLACEHOLDER);
  });

  test('local with a real secret keeps it', () => {
    const secret = 'a'.repeat(32);
    expect(resolveAuthSecret(bindings({ BETTER_AUTH_SECRET: secret }), true)).toBe(secret);
  });

  test('remote with no secret throws', () => {
    expect(() => resolveAuthSecret(bindings(), false)).toThrow(/BETTER_AUTH_SECRET is not set/);
  });

  // This is the one that matters most: an explicitly supplied *development*
  // secret is still a development secret.
  test('remote with the shipped development placeholder throws', () => {
    expect(() =>
      resolveAuthSecret(bindings({ BETTER_AUTH_SECRET: AUTH_SECRET_PLACEHOLDER }), false),
    ).toThrow(/shipped development placeholder/);
  });

  test('remote with a short secret throws', () => {
    expect(() => resolveAuthSecret(bindings({ BETTER_AUTH_SECRET: 'too-short' }), false)).toThrow(
      /32 characters/,
    );
  });

  test('remote with a long-enough secret returns it', () => {
    const secret = 'x'.repeat(32);
    expect(resolveAuthSecret(bindings({ BETTER_AUTH_SECRET: secret }), false)).toBe(secret);
  });

  test('whitespace around a secret is trimmed before the length check', () => {
    expect(() => resolveAuthSecret(bindings({ BETTER_AUTH_SECRET: '  ' }), false)).toThrow(
      /is not set/,
    );
  });
});

describe('backend profile selection', () => {
  test('keeps legacy as the default until cutover', () => {
    expect(resolveBackendProfile({})).toBe('legacy');
  });

  test('refuses unknown profiles and incomplete Supabase preview config', () => {
    expect(() => resolveBackendProfile({ STARTER_BACKEND_PROFILE: 'supabse' })).toThrow(
      /legacy.*supabase/,
    );
    expect(() => resolveBackendProfile({ STARTER_BACKEND_PROFILE: 'supabase' })).toThrow(
      /SUPABASE_URL.*SUPABASE_ANON_KEY.*SUPABASE_SERVICE_ROLE_KEY/,
    );
  });

  test('selects Supabase only with complete public and administrative config', () => {
    expect(
      resolveBackendProfile({
        STARTER_BACKEND_PROFILE: 'supabase',
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: 'anon',
        SUPABASE_SERVICE_ROLE_KEY: 'service',
      }),
    ).toBe('supabase');
  });
});

describe('requireBindings', () => {
  test('a missing D1 binding names the binding and the file to edit', () => {
    expect(() => requireBindings({})).toThrow(/wrangler\.jsonc/);
    expect(() => requireBindings(undefined)).toThrow(/"DB"/);
    expect(() => requireBindings(null)).toThrow(/"DB"/);
  });

  test('a binding set with D1 is returned unchanged', () => {
    const env = bindings();
    expect(requireBindings(env)).toBe(env);
  });
});

describe('parseAbsoluteHttpUrl', () => {
  test.each([
    ['http://127.0.0.1:5173', true],
    ['https://example.com', true],
    ['https://example.com:8443/path', true],
    ['example.com', false],
    ['ws://example.com', false],
    ['https://', false],
  ])('%s -> %s', (value, expected) => {
    expect(parseAbsoluteHttpUrl(value).ok).toBe(expected as boolean);
  });
});
