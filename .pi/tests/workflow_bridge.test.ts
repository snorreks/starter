import { describe, expect, test } from 'bun:test';
import { invokeStarterAgent } from '../lib/workflow_bridge.ts';

describe('Starter workflow bridge', () => {
  test('invokes the real project CLI and validates its checkout and JSON response', async () => {
    const result = await invokeStarterAgent(['describe', '--json'], { operation: 'describe' });
    expect(result.exitCode).toBe(0);
    expect(result.response.status).toBe('passed');
    expect(result.response.checkout).toContain('/starter/');
  });

  test('rejects command output that is not a JSON operation result', async () => {
    await expect(
      invokeStarterAgent(['not-a-command', '--json'], { operation: 'describe' }),
    ).rejects.toThrow('did not return a valid JSON response');
  });

  test('keeps malformed run identifiers out of the project CLI argv', async () => {
    await expect(
      invokeStarterAgent(['visual', 'review', '--run', 'bad/../../path', '--json'], {
        operation: 'review',
      }),
    ).rejects.toThrow('did not return a valid JSON response');
  });
});
