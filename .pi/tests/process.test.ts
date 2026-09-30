// .pi/tests/process.test.ts
//
// The bounded subprocess runner, against real processes.
//
// `runBounded` exists because a tool with a `limit` argument is not bounded: a
// line limit bounds lines, not bytes, and nothing about it stops a process that
// never exits. These tests use real `sh` children so they observe actual byte
// counts, actual SIGTERM handling and actual exit statuses rather than a mock's
// idea of them.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBounded } from '../lib/process.ts';

const artifactRoot = (): string => mkdtempSync(join(tmpdir(), 'pi-process-'));
const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runBounded', () => {
  test('captures stdout and the exit status', async () => {
    const root = artifactRoot();
    cleanups.push(root);

    const result = await runBounded('sh', ['-c', 'printf "hello\\n"; exit 0'], {
      cwd: root,
      timeoutMs: 5_000,
      maxBytes: 64 * 1024,
      artifactRoot: root,
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  test('reports a non-zero exit rather than throwing', async () => {
    const root = artifactRoot();
    cleanups.push(root);

    const result = await runBounded('sh', ['-c', 'printf "boom\\n" >&2; exit 3'], {
      cwd: root,
      timeoutMs: 5_000,
      maxBytes: 64 * 1024,
      artifactRoot: root,
    });

    expect(result.code).toBe(3);
    expect(result.stderr.trim()).toBe('boom');
  });

  test('truncates output past the byte limit and writes the overflow to a file', async () => {
    const root = artifactRoot();
    cleanups.push(root);

    // ~200 KB into a 4 KB budget.
    const result = await runBounded('sh', ['-c', 'yes 0123456789 | head -c 200000'], {
      cwd: root,
      timeoutMs: 10_000,
      maxBytes: 4 * 1024,
      artifactRoot: join(root, 'artifacts'),
    });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4 * 1024);
    expect(result.artifactPath).toBeDefined();
    expect(existsSync(result.artifactPath as string)).toBe(true);
    expect(readFileSync(result.artifactPath as string, 'utf8').length).toBeGreaterThan(100_000);
  });

  test('a process that never exits is stopped and reported as a timeout', async () => {
    const root = artifactRoot();
    cleanups.push(root);

    const started = Date.now();
    const result = await runBounded('sh', ['-c', 'sleep 30'], {
      cwd: root,
      timeoutMs: 300,
      killGraceMs: 200,
      maxBytes: 64 * 1024,
      artifactRoot: root,
    });

    expect(result.timedOut).toBe(true);
    // A killed process has no exit code; reporting 0 would read as success.
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test('an abort signal cancels the run', async () => {
    const root = artifactRoot();
    cleanups.push(root);

    const controller = new AbortController();
    const pending = runBounded('sh', ['-c', 'sleep 30'], {
      cwd: root,
      timeoutMs: 30_000,
      killGraceMs: 200,
      maxBytes: 64 * 1024,
      signal: controller.signal,
      artifactRoot: root,
    });

    setTimeout(() => controller.abort(), 150);
    const result = await pending;

    expect(result.cancelled).toBe(true);
    expect(result.code).not.toBe(0);
  });

  test('a missing binary rejects rather than hanging', async () => {
    const root = artifactRoot();
    cleanups.push(root);

    await expect(
      runBounded('definitely-not-a-real-binary-xyz', [], {
        cwd: root,
        timeoutMs: 5_000,
        maxBytes: 1024,
        artifactRoot: root,
      }),
    ).rejects.toThrow();
  });
});
