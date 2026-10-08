import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/shared/paths.ts';

const invoke = (options: { args: string[]; profile?: string }) => {
  const env = { ...process.env, STARTER_BACKEND_PROFILE: options.profile };
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/src/cli.ts'), 'db', ...options.args],
    {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    },
  );
};

describe('database commands share the deployment profile policy', () => {
  test('an unset selector plans a local Supabase migration without running it', () => {
    const result = invoke({ args: ['migrate', '--dry-run'] });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('would run: supabase');
    expect(result.stdout).not.toContain('wrangler');
  });

  test('an explicit legacy selector still plans the retained D1 migration', () => {
    const result = invoke({ args: ['migrate', '--dry-run'], profile: 'legacy' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('would run: wrangler');
  });

  test.each([['migrate', '--dry-run'], ['seed'], ['status']])(
    '%s refuses an invalid selector before reaching a provider',
    (...args) => {
      const result = invoke({ args, profile: 'misspelled' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('STARTER_BACKEND_PROFILE must be legacy or supabase');
    },
  );
});
