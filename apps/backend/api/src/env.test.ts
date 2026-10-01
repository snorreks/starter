// apps/backend/api/src/env.test.ts
//
// Deployment-mode resolution and auth-secret resolution.
//
// These are the two decisions that decide whether a deployed Worker is allowed to
// run with a development auth secret, and the defect they cover was reachable
// from a plain misconfiguration:
//
//   const isLocal = env.BETTER_AUTH_URL === undefined || env.BETTER_AUTH_URL.includes('localhost');
//
// A Worker deployed without `BETTER_AUTH_URL` — the single most likely binding to
// be missing — satisfied the first clause, was classified local, and got the
// shipped secret. `https://attacker-localhost.example` satisfied the second.
//
// These are pure functions over a binding-shaped object, so they are tested here
// rather than through workerd. The entrypoint behaviour that consumes them is
// covered separately by `tests/worker_integration.test.ts` and by
// `src/worker_config.test.ts`.

import { describe, expect, test } from 'bun:test';
import {
  type ApiEnv,
  AUTH_SECRET_PLACEHOLDER,
  LOCAL_DEFAULT_AUTH_URL,
  parseAbsoluteHttpUrl,
  resolveAuthSecret,
  resolveDeploymentEnvironment,
} from './env.ts';

/** A binding set with only the fields a decision here depends on. */
const bindings = (overrides: Partial<ApiEnv> = {}): ApiEnv =>
  ({
    DB: {} as unknown as D1Database,
    DEPLOYMENT_ENV: 'local',
    BETTER_AUTH_URL: LOCAL_DEFAULT_AUTH_URL,
    ...overrides,
  }) as ApiEnv;

describe('resolveDeploymentEnvironment', () => {
  test('a missing DEPLOYMENT_ENV is an error, not a local default', () => {
    const result = resolveDeploymentEnvironment({ BETTER_AUTH_URL: 'https://api.example.com' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.problem).toContain('DEPLOYMENT_ENV');
  });

  test('an empty DEPLOYMENT_ENV is an error', () => {
    const result = resolveDeploymentEnvironment({
      DEPLOYMENT_ENV: '   ',
      BETTER_AUTH_URL: 'https://api.example.com',
    });
    expect(result.ok).toBe(false);
  });

  test('an unrecognised DEPLOYMENT_ENV is an error, not a local default', () => {
    const result = resolveDeploymentEnvironment({
      DEPLOYMENT_ENV: 'prod',
      BETTER_AUTH_URL: 'https://api.example.com',
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.remedy).toContain('production');
  });

  test('local resolves to local', () => {
    const result = resolveDeploymentEnvironment({
      DEPLOYMENT_ENV: 'local',
      BETTER_AUTH_URL: 'http://127.0.0.1:8787',
    });
    expect(result).toEqual({ ok: true, environment: 'local', isLocal: true });
  });

  test.each(['staging', 'production'])('%s resolves to a remote environment', (environment) => {
    const result = resolveDeploymentEnvironment({
      DEPLOYMENT_ENV: environment,
      BETTER_AUTH_URL: 'https://api.example.com',
    });
    expect(result).toEqual({ ok: true, environment, isLocal: false });
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
      BETTER_AUTH_URL: 'http://api.example.com',
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
    expect(result).toEqual({ ok: true, environment: 'production', isLocal: false });
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

describe('parseAbsoluteHttpUrl', () => {
  test.each([
    ['http://127.0.0.1:8787', true],
    ['https://example.com', true],
    ['https://example.com:8443/path', true],
    ['example.com', false],
    ['ws://example.com', false],
    ['https://', false],
  ])('%s -> %s', (value, expected) => {
    expect(parseAbsoluteHttpUrl(value).ok).toBe(expected as boolean);
  });
});
