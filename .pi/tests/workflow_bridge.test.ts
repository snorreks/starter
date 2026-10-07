import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { invokeStarterAgent } from '../lib/workflow_bridge.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

describe('Starter workflow bridge', () => {
  test('invokes the real project CLI and validates its checkout and JSON response', async () => {
    const result = await invokeStarterAgent(['describe', '--json'], { operation: 'describe' });
    expect(result.exitCode).toBe(0);
    expect(result.response.status).toBe('passed');
    expect(result.response.checkout).toBe(REPO_ROOT);
  });

  test('rejects command output that is not a JSON operation result', async () => {
    await expect(
      invokeStarterAgent(['not-a-command', '--json'], { operation: 'describe' }),
    ).rejects.toThrow('did not return a valid JSON response');
  });

  test('surfaces the project CLI rejection for a malformed run identifier', async () => {
    await expect(
      invokeStarterAgent(['visual', 'review', '--run', 'bad/../../path', '--json'], {
        operation: 'review',
      }),
    ).rejects.toThrow('Invalid run id');
  });

  test('project command limits exceed their inner visual and compute bounds', () => {
    const workflow = JSON.parse(
      readFileSync(new URL('../workflow.json', import.meta.url), 'utf8'),
    ) as { commands: Record<string, { timeoutMs: number }> };
    expect(workflow.commands['visual-capture']?.timeoutMs).toBeGreaterThan(30 * 60_000);
    expect(workflow.commands['compute-full']?.timeoutMs).toBeGreaterThan(35 * 60_000);
  });
});
