// The closed application DTO shared by web and native session clients.
import { describe, expect, test } from 'bun:test';
import { checkSchema, parseSchema } from '../validation.ts';
import { SessionUserSchema, SupabaseSessionUserSchema } from './session.ts';

const user = (overrides: Record<string, unknown> = {}) => ({
  id: 'f45b2c4a-7919-4f55-ae89-e73f6753e322',
  email: 'someone@example.test',
  displayName: 'Someone',
  provider: 'email' as const,
  emailVerified: true,
  ...overrides,
});

for (const schema of [SessionUserSchema, SupabaseSessionUserSchema]) {
  describe('the canonical session boundary', () => {
    test('accepts the application DTO without projection', () => {
      expect(parseSchema(schema, user())).toEqual(user());
    });

    test('rejects non-UUID identities', () => {
      for (const id of ['user_1', 'usr_legacy']) {
        expect(checkSchema(schema, user({ id }))).toBe(false);
      }
    });

    test('rejects the obsolete provider name payload even with a UUID', () => {
      expect(
        checkSchema(schema, {
          id: user().id,
          name: 'Someone',
          email: user().email,
          emailVerified: true,
          image: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ).toBe(false);
    });

    test('rejects unknown identity fields', () => {
      expect(checkSchema(schema, user({ role: 'admin' }))).toBe(false);
      expect(checkSchema(schema, user({ name: 'Someone' }))).toBe(false);
    });

    test('rejects bodies that are not users', () => {
      expect(checkSchema(schema, { code: 'EMAIL_NOT_VERIFIED' })).toBe(false);
    });

    test('rejects unsupported application account categories', () => {
      expect(checkSchema(schema, user({ provider: 'github' }))).toBe(false);
    });

    test('preserves the display name and unverified address', () => {
      const parsed = parseSchema(schema, user({ displayName: 'Ada', emailVerified: false }));
      expect(parsed.displayName).toBe('Ada');
      expect(parsed.emailVerified).toBe(false);
    });
  });
}
