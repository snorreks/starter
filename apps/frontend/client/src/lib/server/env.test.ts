// apps/frontend/client/src/lib/server/env.test.ts
//
// Deployment-mode resolution, public-origin resolution and auth-secret resolution.
//
// These are the decisions that decide whether a deployed Worker is allowed to run
// with a development auth secret, and the defect they cover was reachable from a
// plain misconfiguration:
//
//   const isLocal = env.APP_ORIGIN === undefined || env.APP_ORIGIN.includes('localhost');
//
// A Worker deployed without `APP_ORIGIN` — the single most likely binding to
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
  parseAbsoluteHttpUrl,
  requireBindings,
  requireSupabaseConfig,
  resolveDeploymentEnvironment,
} from './env.ts';

/** A binding set with only the fields a decision here depends on. */
const bindings = (overrides: Partial<AppEnv> = {}): AppEnv =>
  ({
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_ANON_KEY: 'anon-test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-test',
    JOBS_PROFILE: 'disabled',
    DEPLOYMENT_ENV: 'local',
    APP_ORIGIN: 'http://127.0.0.1:5173',
    ...overrides,
  }) as AppEnv;

describe('resolveDeploymentEnvironment', () => {
  test('a missing DEPLOYMENT_ENV is an error, not a local default', () => {
    const result = resolveDeploymentEnvironment({ APP_ORIGIN: 'https://web.example.com' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.problem).toContain('DEPLOYMENT_ENV');
  });

  test('an empty DEPLOYMENT_ENV is an error', () => {
    const result = resolveDeploymentEnvironment({
      DEPLOYMENT_ENV: '   ',
      APP_ORIGIN: 'https://web.example.com',
    });
    expect(result.ok).toBe(false);
  });

  test('an unrecognised DEPLOYMENT_ENV is an error, not a local default', () => {
    const result = resolveDeploymentEnvironment({
      DEPLOYMENT_ENV: 'prod',
      APP_ORIGIN: 'https://web.example.com',
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
      APP_ORIGIN: 'http://127.0.0.1:5173',
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
      APP_ORIGIN: 'https://web.example.com',
    });
    expect(result).toEqual({
      ok: true,
      environment,
      isLocal: false,
      baseUrl: 'https://web.example.com',
    });
  });

  test('a remote environment without APP_ORIGIN fails', () => {
    const result = resolveDeploymentEnvironment({ DEPLOYMENT_ENV: 'production' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.problem).toContain('APP_ORIGIN');
  });

  test('a remote environment over plain http fails', () => {
    const result = resolveDeploymentEnvironment({
      DEPLOYMENT_ENV: 'production',
      APP_ORIGIN: 'http://web.example.com',
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
      APP_ORIGIN: url,
    });
    expect(result).toEqual({
      ok: true,
      environment: 'production',
      isLocal: false,
      baseUrl: url,
    });
  });

  test.each(['not-a-url', 'ftp://example.com', '//example.com', 'https://'])(
    'a malformed APP_ORIGIN is rejected: %s',
    (url) => {
      const result = resolveDeploymentEnvironment({
        DEPLOYMENT_ENV: 'local',
        APP_ORIGIN: url,
      });
      expect(result.ok).toBe(false);
    },
  );
});

describe('the local public origin is derived from the request, and only then', () => {
  test('a local run with no APP_ORIGIN uses the request origin', () => {
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

  test('an explicit APP_ORIGIN still wins over the request origin', () => {
    const result = resolveDeploymentEnvironment(
      { DEPLOYMENT_ENV: 'local', APP_ORIGIN: 'http://localhost:5173' },
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
    expect(result.problem).toContain('APP_ORIGIN');
  });
});

describe('Supabase is the sole backend', () => {
  test('fails with missing Supabase configuration instead of selecting a legacy backend', () => {
    expect(() => requireSupabaseConfig({})).toThrow(
      /SUPABASE_URL.*SUPABASE_ANON_KEY.*SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});

describe('requireBindings', () => {
  test('missing Supabase bindings name the missing values', () => {
    expect(() => requireBindings({})).toThrow(/SUPABASE_URL.*SUPABASE_ANON_KEY/);
    expect(() => requireBindings(undefined)).toThrow(/Worker bindings/);
    expect(() => requireBindings(null)).toThrow(/Worker bindings/);
  });

  test('a complete Supabase binding set is returned unchanged', () => {
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
