import { describe, expect, test } from 'bun:test';
import { parseTarget, planMigrate } from '../src/db/migrate.ts';
import type { ResolvedTarget } from '../src/deploy/target.ts';

describe('Supabase migration target selection', () => {
  test('local remains the safe default and explicit local target', () => {
    expect(parseTarget([])).toBe('local');
    expect(parseTarget(['--local'])).toBe('local');
    expect(planMigrate('local')).toMatchObject({
      ok: true,
      target: 'local',
      args: ['migration', 'up', '--local', '--workdir', expect.any(String)],
    });
  });

  test('remote migration requires one known deployment environment', () => {
    expect(parseTarget(['--remote', 'staging'])).toBe('staging');
    expect(parseTarget(['--remote', 'production'])).toBe('production');
    for (const args of [
      ['--remote'],
      ['--remote', 'local'],
      ['--remote', 'prod'],
      ['--local', '--remote', 'production'],
    ]) {
      expect(parseTarget(args)).toBeNull();
    }
  });

  test('remote plans push the Supabase project migrations without credentials in argv', () => {
    const target = {
      supabase: { projectRef: 'project-ref' },
    } as unknown as ResolvedTarget;
    // The plan builds argv from the project ref and constants, so a credential
    // value planted in the environment must never reach it.
    const sentinel = 'sbp_sentinel_value_that_must_not_reach_argv';
    const previous = process.env.SUPABASE_ACCESS_TOKEN;
    process.env.SUPABASE_ACCESS_TOKEN = sentinel;
    try {
      const plan = planMigrate('staging', target);
      expect(plan).toMatchObject({
        ok: true,
        target: 'staging',
        args: [
          'db',
          'push',
          '--project-ref',
          'project-ref',
          '--include-all',
          '--workdir',
          expect.any(String),
        ],
      });
      if (plan.ok) {
        expect(plan.args.join(' ')).not.toContain(sentinel);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.SUPABASE_ACCESS_TOKEN;
      } else {
        process.env.SUPABASE_ACCESS_TOKEN = previous;
      }
    }
  });
});
