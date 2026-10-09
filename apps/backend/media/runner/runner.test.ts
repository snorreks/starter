import { describe, expect, it } from 'bun:test';
import { executionIdentity, run } from './runner.mjs';

describe('finite runner configuration', () => {
  const env = {
    STARTER_CLOUD_RUN_JOB_RESOURCE: 'projects/p/locations/r/jobs/runner',
    CLOUD_RUN_JOB: 'runner',
    CLOUD_RUN_EXECUTION: 'runner-abc',
  };
  it('uses the documented platform short name with its configured resource', () => {
    expect(executionIdentity(env)).toBe('projects/p/locations/r/jobs/runner/executions/runner-abc');
  });
  it.each([
    { CLOUD_RUN_EXECUTION: '../foreign' },
    { CLOUD_RUN_EXECUTION: 'projects/p/locations/r/jobs/runner/executions/runner-abc' },
    { CLOUD_RUN_JOB: 'foreign' },
    { STARTER_CLOUD_RUN_JOB_RESOURCE: '' },
  ])('rejects missing or contradictory platform execution context %j', (changes) => {
    expect(() => executionIdentity({ ...env, ...changes })).toThrow('execution identity');
  });
  it('refuses callback destinations that could receive identity tokens insecurely', async () => {
    await expect(
      run(['job_a', 'attempt_a'], {
        STARTER_GRANT_ORIGIN: 'http://evil.example',
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow('must use TLS');
    await expect(
      run(['job_a', 'attempt_a'], {
        STARTER_GRANT_ORIGIN: 'https://user:pass@example.com',
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow('origin URL');
  });

  it('rejects nonopaque Cloud Run arguments', async () => {
    await expect(
      run(['../job', 'attempt_a'], {
        STARTER_GRANT_ORIGIN: 'https://app.example',
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow('opaque identifiers');
  });
});
