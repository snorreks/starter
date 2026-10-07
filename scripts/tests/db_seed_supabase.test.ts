import { describe, expect, test } from 'bun:test';
import { seedSupabaseLocal } from '../src/db/seed_supabase.ts';

describe('synthetic Supabase seed stays local and bounded', () => {
  test('uses the checkout-owned CLI and sends synthetic data only to loopback', async () => {
    const calls: {
      command: string;
      args: readonly string[];
      url: string;
      method: string;
      body?: string;
      auth?: string;
    }[] = [];
    const result = await seedSupabaseLocal({
      root: '/checkout',
      binary: 'pinned-supabase',
      run: (command, args, cwd) => {
        calls.push({ command, args, url: cwd, method: 'CLI' });
        return {
          code: 0,
          stdout: 'API_URL="http://127.0.0.1:54321"\nSERVICE_ROLE_KEY="local-secret"',
          stderr: '',
        };
      },
      fetcher: async (input, init = {}) => {
        const url = String(input);
        calls.push({
          command: '',
          args: [],
          url,
          method: init.method ?? 'GET',
          body: typeof init.body === 'string' ? init.body : undefined,
          auth: new Headers(init.headers).get('authorization') ?? undefined,
        });
        return new Response(null, { status: url.includes('/admin/users/') ? 404 : 201 });
      },
    });
    expect(result.noteCount).toBe(2);
    expect(calls[0]?.command).toBe('pinned-supabase');
    expect(calls[0]?.args).toContain('--workdir');
    expect(
      calls.some((call) => call.url.includes('/auth/v1/admin/users') && call.method === 'POST'),
    ).toBe(true);
    expect(
      calls.some((call) => call.url.includes('/rest/v1/notes') && call.body?.includes('Delete me')),
    ).toBe(true);
    expect(
      JSON.stringify({ result, calls: calls.map(({ auth: _auth, ...call }) => call) }),
    ).not.toContain('local-secret');
  });

  test('refuses a non-loopback seed endpoint before sending a request', async () => {
    let requests = 0;
    await expect(
      seedSupabaseLocal({
        binary: 'pinned-supabase',
        run: () => ({
          code: 0,
          stdout: 'API_URL="https://prod.supabase.co"\nSERVICE_ROLE_KEY="secret"',
          stderr: '',
        }),
        fetcher: async () => {
          requests += 1;
          return new Response(null, { status: 200 });
        },
      }),
    ).rejects.toThrow('loopback');
    expect(requests).toBe(0);
  });
});
