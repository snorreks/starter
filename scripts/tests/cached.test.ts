import { describe, expect, test } from 'bun:test';
import { moonLaneEnvironment, parseCachedArguments } from '../src/commands/cached.ts';

describe('the owning integration harness runs the sole backend', () => {
  test('detects the Worker preview target', () => {
    expect(parseCachedArguments(['--', 'client:test-worker'])).toEqual({
      targets: ['client:test-worker'],
      integrationRuntime: true,
    });
  });

  test('does not enable a local stack for credential-free unit tests', () => {
    expect(parseCachedArguments(['--', ':test'])).toEqual({
      targets: [':test'],
      integrationRuntime: false,
    });
  });
});

describe('the environment every root lane hands Moon', () => {
  test('points Moon at the Bun on PATH rather than a proto store', () => {
    // `bun run test` reached this failure before a single test ran:
    //
    //   × This project requires Bun 1.4.3 (detected from …/.bun-version), but
    //     this version has not been installed. Install it with proto install bun
    //
    // Moon embeds protox, so a lane without this switch never reaches the Bun
    // that `nix develop` and `setup:doctor` verified. docs/toolchain.md.
    expect(moonLaneEnvironment({}).MOON_TOOLCHAIN_FORCE_GLOBALS).toBe('1');
  });

  test('carries no credential into the task tree', () => {
    const env = moonLaneEnvironment({
      PATH: '/nix/store/bun/bin',
      SUPABASE_SERVICE_ROLE_KEY: 'fixture-secret',
      RESEND_API_KEY: 'fixture-secret',
    });

    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/nix/store/bun/bin');
  });
});
