import { describe, expect, test } from 'bun:test';
import { parseCachedArguments } from '../src/commands/cached.ts';

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
