import { describe, expect, test } from 'bun:test';
import { getContainer } from './container.ts';

const bindings = (overrides: Record<string, unknown> = {}) => ({
  DEPLOYMENT_ENV: 'local',
  APP_ORIGIN: 'http://127.0.0.1:5173',
  JOBS_PROFILE: 'disabled',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'anon-test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-test',
  ...overrides,
});

describe('the Worker container uses Supabase only', () => {
  test('rejects missing Supabase config before constructing services', () => {
    expect(() => getContainer({ DEPLOYMENT_ENV: 'local', JOBS_PROFILE: 'disabled' })).toThrow(
      /SUPABASE_URL/,
    );
  });

  test('requires an explicit disabled or enabled compute profile', () => {
    expect(() => getContainer(bindings({ JOBS_PROFILE: undefined }))).toThrow(/JOBS_PROFILE/);
  });

  test('constructs the application with explicitly disabled compute', () => {
    const container = getContainer(bindings());
    expect(container.supabase.url).toBe('http://127.0.0.1:54321');
    expect(container.jobsProfile).toBe('disabled');
  });

  test('refuses enabled compute without its workflow and bucket bindings', () => {
    expect(() => getContainer(bindings({ JOBS_PROFILE: 'encode' }))).toThrow(
      /ENCODE_WORKFLOW.*MEDIA/,
    );
  });
});
