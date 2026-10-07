import { afterEach, describe, expect, test } from 'bun:test';
import { main } from '../src/cli.ts';

const originalWrite = process.stdout.write;
let output = '';
afterEach(() => {
  process.stdout.write = originalWrite;
  output = '';
});

describe('agent JSON facade', () => {
  test('describe emits one schema-versioned capability result with unavailable work named', async () => {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    expect(await main(['agent', 'describe', '--json'])).toBe(0);
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(1);
    const first = lines[0];
    expect(first).toBeDefined();
    const result = JSON.parse(first ?? '');
    expect(result).toMatchObject({ schemaVersion: 1, operation: 'describe', status: 'passed' });
    expect(
      result.capabilities.find((capability: { id: string }) => capability.id === 'runtime:built'),
    ).toMatchObject({ status: 'not-run', remedy: expect.stringContaining('owned runtime') });
    expect(result.rerun).toContain('bun run agent -- describe --json');
  });

  test('built doctor reports the unavailable owned runtime and exits nonzero', async () => {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    expect(await main(['agent', 'doctor', '--profile', 'built', '--json'])).toBe(3);
    const result = JSON.parse(output.trim());
    expect(result).toMatchObject({
      schemaVersion: 1,
      operation: 'doctor',
      profile: 'built',
      status: 'not-run',
    });
    expect(result.rerun).toContain('bun run agent -- doctor --profile built --json');
  });
});
