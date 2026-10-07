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
    expect(services.jobs.computeRequested).toBe(false);
    expect(services.notes).toBeDefined();
    expect(services.chat).toBeDefined();
  });

  test('keeps an enabled but unbound compute profile distinguishable from disabled compute', () => {
    const services = createApplicationServices(identity, { ...config, jobsProfile: 'encode' });
    expect(services.jobs.computeRequested).toBe(true);
    expect(services.jobs.dispatch).toBe('disabled_pending_prompt_06');
  });

  test('starts one deterministically named Workflow with opaque ids and the frozen job contract', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ id: string; params?: unknown }> = [];
    globalThis.fetch = Object.assign(async () => Response.json(true), {
      preconnect: originalFetch.preconnect,
    });
    try {
      const services = createApplicationServices(identity, {
        ...config,
        jobsProfile: 'encode',
        encodeWorkflow: {
          create: async (input) => {
            calls.push(input);
            return { id: input.id };
          },
          get: async (id) => ({ status: async () => ({ status: id }) }),
        },
      });
      expect(services.jobs.dispatch).toBe('cloud_run');
      expect(
        await services.jobs.startEncode({
          jobId: 'job_123',
          attemptId: 'attempt_123',
          fixture: 'sample-v1',
          preset: 'demo-180p-v1',
        }),
      ).toBe(true);
      expect(calls).toEqual([
        {
          id: 'encode-job_123',
          params: {
            jobId: 'job_123',
            fixture: 'sample-v1',
            preset: 'demo-180p-v1',
            attemptId: 'attempt_123',
          },
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
