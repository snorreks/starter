import { describe, expect, test } from 'bun:test';
import { createSupabaseIdentityResolver, type SupabaseFetch } from './identity.ts';

const request = (token: string): Request =>
  new Request('https://app.example.test/notes', {
    headers: { authorization: `Bearer ${token}` },
  });

const cookies = { getAll: () => [], setAll: () => {} };

describe('Supabase identity is verified for each request', () => {
  test('rejects a spoofed bearer token returned as an invalid user response', async () => {
    const resolver = createSupabaseIdentityResolver(
      { url: 'http://127.0.0.1:54321', anonKey: 'anon-test' },
      (async () =>
        new Response(JSON.stringify({ message: 'invalid token' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as SupabaseFetch,
    );

    await expect(resolver.getVerifiedIdentity(request('forged.jwt.value'), cookies)).resolves.toBe(
      null,
    );
  });

  test('rejects an expired bearer token', async () => {
    const resolver = createSupabaseIdentityResolver(
      { url: 'http://127.0.0.1:54321', anonKey: 'anon-test' },
      (async () =>
        new Response(JSON.stringify({ message: 'JWT expired' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as SupabaseFetch,
    );

    await expect(resolver.getVerifiedIdentity(request('expired.jwt.value'), cookies)).resolves.toBe(
      null,
    );
  });

  test('refuses missing public preview configuration by name', () => {
    expect(() => createSupabaseIdentityResolver({ url: '', anonKey: '' })).toThrow(
      /SUPABASE_URL.*SUPABASE_ANON_KEY/,
    );
  });
});
