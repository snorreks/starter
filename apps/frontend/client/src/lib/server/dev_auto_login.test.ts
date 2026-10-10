// apps/frontend/client/src/lib/server/dev_auto_login.test.ts
//
// The refusals, asserted directly.
//
// Every case below is a way this feature could sign a developer in on a machine
// where it must not: a deployment that kept a development binding, a project URL
// that merely looks local, a flag value nobody intended. The sign-in itself is
// Supabase Auth's, and the E2E lane covers it end to end; what is testable here
// is the decision, and a decision nobody can exercise without a stack is a
// decision nobody changes safely.

import { describe, expect, test } from 'bun:test';
import {
  DEV_AUTO_LOGIN_BINDING,
  DEV_AUTO_LOGIN_EMAIL_BINDING,
  DEV_AUTO_LOGIN_MODE,
  DEV_AUTO_LOGIN_PASSWORD_BINDING,
  DEV_SIGNED_OUT_COOKIE,
  devAutoSignInFor,
} from './dev_auto_login.ts';
import type { AppEnv } from './env.ts';

const LOCAL: AppEnv = {
  DEPLOYMENT_ENV: 'local',
  SUPABASE_URL: 'http://127.0.0.1:60609',
  [DEV_AUTO_LOGIN_BINDING]: DEV_AUTO_LOGIN_MODE,
  [DEV_AUTO_LOGIN_EMAIL_BINDING]: 'seed@example.invalid',
  [DEV_AUTO_LOGIN_PASSWORD_BINDING]: 'local-synthetic-seed-only',
};

describe('the local development auto sign-in', () => {
  test('signs in the seeded account on a loopback stack it was configured for', () => {
    expect(devAutoSignInFor(LOCAL, true)).toEqual({
      email: 'seed@example.invalid',
      password: 'local-synthetic-seed-only',
    });
  });

  // The control for the test above: this one has to fail, or the first asserts
  // nothing. A near-identical configuration with one thing wrong.
  test('refuses the same bindings on a deployment that is not local', () => {
    expect(devAutoSignInFor(LOCAL, false)).toBeNull();
    expect(devAutoSignInFor({ ...LOCAL, DEPLOYMENT_ENV: 'staging' }, false)).toBeNull();
  });

  test('refuses a project URL that is not plain http on loopback', () => {
    // The failure this exists to prevent: a hosted project reached through a name
    // that contains "localhost", or a loopback name under https, or no URL at all.
    expect(
      devAutoSignInFor({ ...LOCAL, SUPABASE_URL: 'https://abc.supabase.co' }, true),
    ).toBeNull();
    expect(
      devAutoSignInFor({ ...LOCAL, SUPABASE_URL: 'http://localhost:54321' }, true),
    ).not.toBeNull();
    expect(
      devAutoSignInFor({ ...LOCAL, SUPABASE_URL: 'https://127.0.0.1:60609' }, true),
    ).toBeNull();
    expect(devAutoSignInFor({ ...LOCAL, SUPABASE_URL: undefined }, true)).toBeNull();
    expect(
      devAutoSignInFor({ ...LOCAL, SUPABASE_URL: 'http://evil-localhost.example' }, true),
    ).toBeNull();
  });

  test('refuses without the explicit mode, whatever else is present', () => {
    // A test lane, a deployment, or a developer who set the account and forgot
    // the mode. Nothing here is inferred from the account's presence.
    const withoutMode: AppEnv = {
      DEPLOYMENT_ENV: 'local',
      SUPABASE_URL: 'http://127.0.0.1:60609',
      [DEV_AUTO_LOGIN_EMAIL_BINDING]: 'seed@example.invalid',
      [DEV_AUTO_LOGIN_PASSWORD_BINDING]: 'local-synthetic-seed-only',
    };
    expect(devAutoSignInFor(withoutMode, true)).toBeNull();
    for (const value of ['true', '1', 'yes', 'SEED', 'seeded', '']) {
      expect(devAutoSignInFor({ ...LOCAL, [DEV_AUTO_LOGIN_BINDING]: value }, true)).toBeNull();
    }
    // A dotenv file is written by a human now and then, so surrounding whitespace
    // is tolerated. That is the *only* thing trimming buys.
    expect(devAutoSignInFor({ ...LOCAL, [DEV_AUTO_LOGIN_BINDING]: ' seed ' }, true)).not.toBeNull();
  });

  test('refuses a half-configured account rather than signing in as nobody', () => {
    expect(
      devAutoSignInFor({ ...LOCAL, [DEV_AUTO_LOGIN_PASSWORD_BINDING]: undefined }, true),
    ).toBeNull();
    expect(devAutoSignInFor({ ...LOCAL, [DEV_AUTO_LOGIN_EMAIL_BINDING]: '  ' }, true)).toBeNull();
  });

  // The value the launcher writes. Asserted here so the writer's literal and this
  // reader's are pinned on both sides of the boundary they cannot share.
  test('the mode word the dev launcher writes is the one this accepts', () => {
    expect(DEV_AUTO_LOGIN_MODE).toBe('seed');
    expect(DEV_SIGNED_OUT_COOKIE.length).toBeGreaterThan(0);
  });
});

for (const name of ['sb-local-auth-token', 'sb-local-auth-token.0', 'sb-local-auth-token.1']) {
  test(`an existing ${name} cookie preserves the current account`, async () => {
    const { applyDevAutoSignIn } = await import('./dev_auto_login.ts');
    const container = { env: LOCAL, isLocal: true } as Parameters<typeof applyDevAutoSignIn>[0];
    const cookies = {
      get: () => undefined,
      getAll: () => [{ name, value: 'existing-session' }],
    } as unknown as Parameters<typeof applyDevAutoSignIn>[1];
    expect(
      await applyDevAutoSignIn(container, cookies, new Request('http://localhost/notes')),
    ).toBe('existing-session');
  });
}
