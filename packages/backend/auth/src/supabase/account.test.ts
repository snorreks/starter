import { beforeEach, describe, expect, test } from 'bun:test';
import { createSupabaseAccountService } from './account.ts';

const results: string[] = [];
const auth = {
  auth: {
    signUp: async (input: unknown) => {
      results.push(`signup:${JSON.stringify(input)}`);
      return {
        data: {
          user: { id: 'c45b6bf6-d744-4e0e-bb61-39d20bef7890', email: 'a@example.test' },
          session: null,
        },
        error: null,
      };
    },
    signInWithPassword: async () => ({
      data: {
        user: { id: 'c45b6bf6-d744-4e0e-bb61-39d20bef7890', email: 'a@example.test' },
        session: { access_token: 'access' },
      },
      error: null,
    }),
    signOut: async () => ({ error: null }),
    resetPasswordForEmail: async (_email: string, options: { redirectTo: string }) => {
      results.push(options.redirectTo);
      return { data: {}, error: null };
    },
    updateUser: async (input: unknown) => {
      results.push(JSON.stringify(input));
      return { data: {}, error: null };
    },
  },
};
const admin = {
  auth: {
    admin: {
      deleteUser: async (id: string) => {
        results.push(`delete:${id}`);
        return { data: {}, error: null };
      },
    },
  },
};

const makeService = () =>
  createSupabaseAccountService(auth as never, admin as never, {
    origin: 'https://app.example.test',
    allowedCallbacks: ['/auth/callback', '/reset-password', '/verify-email'],
  });

describe('Supabase account lifecycle', () => {
  beforeEach(() => {
    results.length = 0;
  });
  test('rejects callback URLs outside the configured path allowlist', async () => {
    const service = makeService();
    await expect(
      service.requestPasswordReset({ email: 'a@example.test', redirectTo: 'https://evil.test' }),
    ).rejects.toThrow(/callback/i);
    expect(results).toHaveLength(0);
  });

  test('password recovery always uses the same-site callback', async () => {
    await makeService().requestPasswordReset({
      email: 'a@example.test',
      redirectTo: '/reset-password',
    });
    expect(results).toEqual(['https://app.example.test/auth/callback?next=%2Freset-password']);
  });
});

for (const status of [429, 503, undefined]) {
  test(`preserves provider status ${status ?? 'missing'} with a 400 fallback`, async () => {
    const client = { auth: { signOut: async () => ({ error: { message: 'refused', status } }) } };
    const service = createSupabaseAccountService(client as never, admin as never, {
      origin: 'https://app.example.test',
      allowedCallbacks: [],
    });
    await expect(service.signOut()).rejects.toMatchObject({ status: status ?? 400 });
  });
}
