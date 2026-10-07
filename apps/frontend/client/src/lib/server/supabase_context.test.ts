import { describe, expect, test } from 'bun:test';
import { createApplicationServices } from './supabase_context.ts';

const identity = {
  backend: 'supabase' as const,
  accessToken: 'user-access-token',
  user: {
    id: 'c45b6bf6-d744-4e0e-bb61-39d20bef7890',
    email: 'a@example.test',
    displayName: 'A',
    emailVerified: true,
  },
};
const config = {
  url: 'http://127.0.0.1:54321',
  anonKey: 'local-anon',
  serviceRoleKey: 'local-service-role',
  origin: 'http://127.0.0.1:4183',
  allowedCallbacks: ['/verify-email', '/reset-password'],
};

describe('application services reject identities from another backend', () => {
  test('does not build Supabase repositories for a legacy identity', () => {
    expect(() =>
      createApplicationServices({ ...identity, backend: 'legacy' } as never, config),
    ).toThrow(/backend identity/i);
  });

  test('creates only a per-user data service for the verified Supabase identity', () => {
    const services = createApplicationServices(identity, config);
    expect(services.identity.user.id).toBe(identity.user.id);
    expect(services.jobs.dispatch).toBe('disabled_pending_prompt_06');
    expect(services.notes).toBeDefined();
    expect(services.chat).toBeDefined();
  });
});
