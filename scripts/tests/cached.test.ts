import { describe, expect, test } from 'bun:test';
import { parseCachedArguments } from '../src/commands/cached.ts';

describe('backend selection is consumed by the harness', () => {
  test('removes the preview option before passing targets to Moon', () => {
    expect(parseCachedArguments(['--', 'client:test-worker', '--backend', 'supabase'])).toEqual({
      backend: 'supabase',
      targets: ['client:test-worker'],
      supabaseCompute: false,
    });
  });

  test('routes the explicit Supabase Cloud Run local processor selection through Moon', () => {
    expect(
      parseCachedArguments([
        '--',
        'jobs-worker:test-compute',
        '--backend',
        'supabase',
        '--processor',
        'cloud-run-local',
      ]),
    ).toEqual({
      backend: 'supabase',
      targets: [
        'jobs-worker:test-compute',
        '--',
        '--backend',
        'supabase',
        '--processor',
        'cloud-run-local',
      ],
      supabaseCompute: true,
    });
  });

  test('refuses an unconfigured Supabase compute processor', () => {
    expect(() =>
      parseCachedArguments([
        '--',
        'jobs-worker:test-compute',
        '--backend',
        'supabase',
        '--processor',
        'cloud-run',
      ]),
    ).toThrow(/requires `--processor cloud-run-local`/);
  });

  test('requires the mandatory preview integration target', () => {
    expect(() => parseCachedArguments(['--', ':test', '--backend', 'supabase'])).toThrow(
      /requires client:test-worker or e2e:e2e/,
    );
  });

  test('refuses unknown or repeated backend options', () => {
    expect(() =>
      parseCachedArguments(['--backend', 'unknown', '--', 'client:test-worker']),
    ).toThrow(/legacy or supabase/);
    expect(() =>
      parseCachedArguments([
        '--backend',
        'legacy',
        '--backend',
        'supabase',
        '--',
        'client:test-worker',
      ]),
    ).toThrow(/appear once/);
  });
});
