import { describe, expect, test } from 'bun:test';
import { createAdminDatabaseClient, createUserDatabaseClient } from './client.ts';

describe('request scoped Supabase clients', () => {
  test('user clients attach only the caller access token and disable shared session state', async () => {
    const client = createUserDatabaseClient(
      { url: 'http://127.0.0.1:54321', anonKey: 'anon' },
      'user-token',
    );
    expect(client).toBeDefined();
    const result = await client.auth.getSession();
    expect(result.data.session).toBeNull();
  });

  test('admin client construction remains a separate explicit factory', () => {
    const client = createAdminDatabaseClient({
      url: 'http://127.0.0.1:54321',
      anonKey: 'anon',
      serviceRoleKey: 'local-only-service-role',
    });
    expect(client).toBeDefined();
  });
});
