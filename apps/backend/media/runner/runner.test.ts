import { describe, expect, it } from 'bun:test';
import { run } from './runner.mjs';

describe('finite runner configuration', () => {
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
