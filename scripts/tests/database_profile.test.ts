import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/shared/paths.ts';

const invoke = (args: string[]) =>
  spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/src/cli.ts'), 'db', ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });

/** Run with a stale selector in the environment, then restore the caller's value. */
const withProfile = (profile: string, run: () => ReturnType<typeof invoke>) => {
  const previous = process.env.STARTER_BACKEND_PROFILE;
  process.env.STARTER_BACKEND_PROFILE = profile;
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.STARTER_BACKEND_PROFILE;
    } else {
      process.env.STARTER_BACKEND_PROFILE = previous;
    }
  }
};

describe('database commands always target Supabase', () => {
  test('an unset selector plans a local Supabase migration without running it', () => {
    const result = invoke(['migrate', '--dry-run']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('would run: supabase');
    expect(result.stdout).not.toContain('wrangler');
  });

  // The legacy D1 profile went with the legacy backend. A stale selector must not
  // plan D1 again, and it is not a second way to choose a backend: nothing reads
  // it, so every command still plans Supabase.
  test.each(['legacy', 'misspelled'] as const)(
    'a stale %s selector cannot plan a D1 migration',
    (profile) => {
      const result = withProfile(profile, () => invoke(['migrate', '--dry-run']));
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('would run: supabase');
      expect(result.stdout).not.toContain('wrangler');
    },
  );

  test.each(['migrate', 'seed', 'status'] as const)(
    '%s refuses an unknown backend flag before reaching a provider',
    (command) => {
      const args =
        command === 'migrate'
          ? [command, '--dry-run', '--backend', 'legacy']
          : [command, '--backend', 'legacy'];
      const result = invoke(args);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
    },
  );
});
