// packages/shared/schemas/src/auth/session.test.ts
//
// The closed application DTO shared by web and native session clients.

import { describe, expect, test } from 'bun:test';
import { checkSchema } from '../validation.ts';
import { SessionUserWireSchema, toSessionUser } from './session.ts';

/** The user object returned by the application's session endpoint. */
const wire = (overrides: Record<string, unknown> = {}) => ({
  id: 'f45b2c4a-7919-4f55-ae89-e73f6753e322',
  email: 'someone@example.test',
  displayName: 'Someone',
  provider: 'email',
  emailVerified: true,
  ...overrides,
});

describe('the session DTO is validated at the client boundary', () => {
  test('the expected Supabase-backed identity shape is accepted', () => {
    expect(checkSchema(SessionUserWireSchema, wire())).toBe(true);
  });

  test('a field this build does not know about is refused', () => {
    // Unknown identity fields are rejected at the shared boundary.
    expect(checkSchema(SessionUserWireSchema, wire({ role: 'admin' }))).toBe(false);
  });

  test('a body that is not a user at all is refused', () => {
    expect(checkSchema(SessionUserWireSchema, { code: 'EMAIL_NOT_VERIFIED' })).toBe(false);
  });
});

describe('the projection carries only what the DTO names', () => {
  test('displayName is carried as the application field', () => {
    const user = toSessionUser(wire({ displayName: 'Ada Lovelace' }) as never);

    expect(user.displayName).toBe('Ada Lovelace');
  });

  test('provider is the literal, not a value read from the response', () => {
    // Only email and password is enabled. A provider string from a response body
    // would let a server claim an authentication method this application has no
    // handler for.
    expect(toSessionUser(wire() as never).provider).toBe('email');
  });

  test('the DTO contains only the shared application fields', () => {
    const user = toSessionUser(wire() as never);

    expect(Object.keys(user).toSorted()).toEqual([
      'displayName',
      'email',
      'emailVerified',
      'id',
      'provider',
    ]);
  });

  test('an unverified address stays unverified', () => {
    expect(toSessionUser(wire({ emailVerified: false }) as never).emailVerified).toBe(false);
  });
});
