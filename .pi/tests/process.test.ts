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
import { setTimeout as sleep } from 'node:timers/promises';
import { startJob } from '../lib/jobs.ts';
import { runBounded } from '../lib/process.ts';

const artifactRoot = (): string => mkdtempSync(join(tmpdir(), 'pi-process-'));
const cleanups: string[] = [];

/**
 * Has this pid stopped existing?
 *
 * Polled rather than probed once, because the signal is asynchronous: the run can
 * settle on `close` microseconds before the killed process is reaped, and a
 * single probe would fail on that ordering rather than on a survivor.
 */
const processGone = async (pid: number, budgetMs = 3_000): Promise<boolean> => {
  for (let waited = 0; waited < budgetMs; waited += 50) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(50);
  }
  return false;
};

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runBounded', () => {
  test('writes a bounded JSON payload to child stdin without placing it in argv', async () => {
    const result = await runBounded('sh', ['-c', 'cat'], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxBytes: 1024,
      input: '{"url":"http://127.0.0.1/private?token=redacted"}',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"url":"http://127.0.0.1/private?token=redacted"}');
  });

  test('refuses an oversized stdin payload before starting the child', async () => {
    let message = '';
    try {
      await runBounded('definitely-not-a-real-binary', [], {
        cwd: process.cwd(),
        timeoutMs: 500,
        maxBytes: 1024,
        input: 'x'.repeat(129),
        maxInputBytes: 128,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('stdin exceeded its 128 byte limit');
  });

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

  test('a forked grandchild cannot hold the run open', async () => {
    // The regression this file's other timeout test could not catch.
    //
    // `sh -c 'sleep 30'` makes the shell `exec` the sleep, so the shell and the
    // sleep are one process and a signal to the child is enough. `sleep 30 & wait`
    // forces a fork: the sleep is a separate process holding the inherited stdout
    // pipe. Signalling only the direct child then kills the shell, but `close`
    // waits on that pipe forever, so the run never settles.
    //
    // This is not a shell-dialect curiosity. It is why both timeout tests above
    // passed on a laptop in 484 ms and failed on every GitHub runner at exactly
    // 5000 ms: Ubuntu's `/bin/sh` is dash, which forks where bash execs. The
    // runner logs showed `Terminate orphan process: sleep`, which is the orphan
    // outliving the shell that was supposed to have killed it.
    //
    // So the bound has to hold for a command that leaves something behind, not
    // only for one that is a single process.
    const root = artifactRoot();
    cleanups.push(root);

    // The orphan's own pid, recorded by the shell itself, so the assertion below
    // is about that process and not about the promise having returned.
    const pidFile = join(root, 'grandchild.pid');

    const started = Date.now();
    const result = await runBounded('sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], {
      cwd: root,
      timeoutMs: 300,
      killGraceMs: 200,
      maxBytes: 64 * 1024,
      artifactRoot: root,
    });

    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    // Without the process-group kill this never returns, and the test framework
    // reports a timeout rather than an assertion failure. A generous ceiling still
    // catches a hang, but on the assertion rather than on the framework.
    expect(Date.now() - started).toBeLessThan(4_000);

    // And the orphan is gone, not merely unreported: a bound that settles while a
    // process it spawned keeps running bounds the wait, not the work.
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    expect(Number.isInteger(pid)).toBe(true);
    expect(pid).toBeGreaterThan(1);
    expect(await processGone(pid)).toBe(true);
  });

  test('a backgrounded process outliving the shell is still bounded', async () => {
    // The same hang reached through the other order of events, which the test
    // above cannot reach: there the shell outlives its child.
    //
    // Here the shell exits immediately and only the backgrounded `sleep` is left,
    // holding the inherited stdout pipe. So `child.exitCode` is already set while
    // `close` cannot fire. A kill guard that asks whether the *child* exited says
    // "nothing to do" — on the timeout, and on the SIGKILL that follows it — and
    // the run hangs with the timeout having had no effect at all.
    //
    // `code` is deliberately not asserted here: the shell really did exit 0. What
    // must hold is that the timeout fired and the run still finished.
    const root = artifactRoot();
    cleanups.push(root);

    const pidFile = join(root, 'orphan.pid');

    const started = Date.now();
    const result = await runBounded('sh', ['-c', `sleep 30 & echo $! > "${pidFile}"`], {
      cwd: root,
      timeoutMs: 300,
      killGraceMs: 200,
      maxBytes: 64 * 1024,
      artifactRoot: root,
    });

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);

    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    expect(Number.isInteger(pid)).toBe(true);
    expect(await processGone(pid)).toBe(true);
  });

  test('multibyte output cannot push the kept text past the byte limit', async () => {
    // `room` is a byte count and `slice` counts UTF-16 code units, so truncating a
    // multibyte chunk at `room` *units* kept up to three times the budget. The
    // byte limit has to be a byte limit, which is the entire contract of
    // `maxBytes`.
    const root = artifactRoot();
    cleanups.push(root);

    const maxBytes = 1024;
    const result = await runBounded('sh', ['-c', 'yes ééééé | head -c 100000'], {
      cwd: root,
      timeoutMs: 10_000,
      maxBytes,
      artifactRoot: join(root, 'artifacts'),
    });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(maxBytes);
    // The dropped remainder is still on disk, so nothing is lost by the bound.
    expect(result.artifactPath).toBeDefined();
    expect(readFileSync(result.artifactPath as string).byteLength).toBeGreaterThan(50_000);
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

  test('the owned runtime environment keeps host prerequisites but strips unrelated secrets', async () => {
    const root = artifactRoot();
    cleanups.push(root);
    const previous = process.env.PI_TEST_RUNTIME_SECRET;
    process.env.PI_TEST_RUNTIME_SECRET = 'sentinel-not-for-runtime';
    try {
      const { handle } = startJob(
        'sh',
        ['-c', 'printf "%s|%s" "$PATH" "$PI_TEST_RUNTIME_SECRET"'],
        {
          cwd: root,
          timeoutMs: 5_000,
          maxBytes: 1024,
          environment: 'starter-runtime',
        },
      );
      const finished = await handle.wait();
      expect(finished.state).toBe('exited');
      const [path, secret] = handle.tail().split('|');
      expect(path).toBeTruthy();
      expect(secret).toBe('');
    } finally {
      if (previous === undefined) {
        delete process.env.PI_TEST_RUNTIME_SECRET;
      } else {
        process.env.PI_TEST_RUNTIME_SECRET = previous;
      }
    }
  });
});
