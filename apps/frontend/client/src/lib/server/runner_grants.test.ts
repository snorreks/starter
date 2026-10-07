import { describe, expect, it } from 'bun:test';
import { createRunnerGrantService, processorFailureForExitCode } from './runner_grants.ts';

describe('runner grants fail closed', () => {
  it('requires explicit Postgres, grant, identity and R2 configuration', () => {
    expect(() => createRunnerGrantService({}, 'https://app.example')).toThrow(
      'Runner grant configuration is incomplete',
    );
  });

  it('refuses insecure public callback origins', () => {
    expect(() =>
      createRunnerGrantService(
        {
          SUPABASE_URL: 'https://db.example',
          SUPABASE_ANON_KEY: 'anon',
          SUPABASE_SERVICE_ROLE_KEY: 'service',
          RUNNER_GRANT_SECRET: 'a'.repeat(32),
          GOOGLE_RUNNER_AUDIENCE: 'https://app.example',
          GOOGLE_RUNNER_SERVICE_ACCOUNT: 'runner@project.iam.gserviceaccount.com',
          GOOGLE_RUNNER_SUBJECT: '1234567890',
          MEDIA: {} as R2Bucket,
        },
        'http://evil.example',
      ),
    ).toThrow('HTTPS application origin');
  });

  it('refuses grant signing keys shorter than 256 bits', () => {
    expect(() =>
      createRunnerGrantService(
        {
          SUPABASE_URL: 'https://db.example',
          SUPABASE_ANON_KEY: 'anon',
          SUPABASE_SERVICE_ROLE_KEY: 'service',
          RUNNER_GRANT_SECRET: 'too-short',
          GOOGLE_RUNNER_AUDIENCE: 'https://app.example',
          GOOGLE_RUNNER_SERVICE_ACCOUNT: 'runner@project.iam.gserviceaccount.com',
          GOOGLE_RUNNER_SUBJECT: '1234567890',
          MEDIA: {} as R2Bucket,
        },
        'https://app.example',
      ),
    ).toThrow('at least 32 bytes');
  });
});

describe('finite processor exit classification', () => {
  it('preserves terminal media errors and retries bounded transient failures', () => {
    for (const code of [2, 3, 4, 5, 6]) {
      expect(processorFailureForExitCode(code)?.retryable).toBe(false);
    }
    for (const code of [7, 8, 9]) {
      expect(processorFailureForExitCode(code)?.retryable).toBe(true);
    }
    expect(processorFailureForExitCode(1)).toBeUndefined();
  });
});
