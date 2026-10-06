// packages/shared/schemas/src/auth/session.test.ts
//
// The provider's user, and the DTO it is projected onto.
//
// The case that matters is the projection: the provider says `name` and this
// application says `displayName`. Treating the two as the same type produced a
// `SessionUser` whose display name was `undefined`, which no test caught until
// the end-to-end lane asked a screen to render one. So the wire shape is stated,
// closed, and projected.

import { describe, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { SessionUserWireSchema, toSessionUser } from './session.ts';

/** The row Better Auth returns: every field on the `users` table, serialized. */
const wire = (overrides: Record<string, unknown> = {}) => ({
  id: 'user_1',
  name: 'Someone',
  email: 'someone@example.test',
  emailVerified: true,
  image: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('the provider user is accepted as it is sent', () => {
  test('a null image is accepted, because the column is nullable', () => {
    expect(Value.Check(SessionUserWireSchema, wire())).toBe(true);
    expect(Value.Check(SessionUserWireSchema, wire({ image: 'https://cdn.test/a.png' }))).toBe(
      true,
    );
  });

  test('a field this build does not know about is refused', () => {
    // A closed wire schema on purpose: a Better Auth upgrade that adds a field
    // becomes a visible refusal at the boundary rather than a silently different
    // identity shape reaching a screen.
    expect(Value.Check(SessionUserWireSchema, wire({ role: 'admin' }))).toBe(false);
  });

  test('a body that is not a user at all is refused', () => {
    expect(Value.Check(SessionUserWireSchema, { code: 'EMAIL_NOT_VERIFIED' })).toBe(false);
  });
});

describe('the projection carries only what the DTO names', () => {
  test('displayName comes from the provider name field', () => {
    const user = toSessionUser(wire({ name: 'Ada Lovelace' }) as never);

    expect(user.displayName).toBe('Ada Lovelace');
  });

  test('provider is the literal, not a value read from the response', () => {
    // Only email and password is enabled. A provider string from a response body
    // would let a server claim an authentication method this application has no
    // handler for.
    expect(toSessionUser(wire() as never).provider).toBe('email');
  });

  test('the timestamps and the image are dropped rather than carried', () => {
    // The DTO is what reaches a screen, a log line and a native bundle. A field
    // left on it is a field every one of those now has to decide about.
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
