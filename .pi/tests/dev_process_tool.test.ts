// .pi/tests/dev_process_tool.test.ts
//
// The `dev_process` tool, driven end-to-end against real local processes.
//
// This is where the tool's central promise is either true or not: **completion is
// the process's exit status, and never the silence.** Every test here uses an
// actual executable in a temporary directory, because a mock cannot demonstrate
// that a quiet process is still running.
//
// Nothing manipulates an unrelated live process. Every job is started by this
// test, in a scratch directory, and stopped by this test.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import devProcessExtension from '../extensions/dev_process.ts';
import { jobDir, jobJsonPath, jobLogPath } from '../lib/jobs.ts';
import { cleanupFakes, fakeBin } from './fake_bin.ts';

afterAll(cleanupFakes);

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Journal entries this file created.
 *
 * The extension resolves its repository root from `import.meta.url`, so its jobs
 * land in the real `.pi/background-tasks/` — the same place a real session writes,
 * which is what makes these end-to-end tests worth running. The cost is that the
 * journal has to be cleaned up afterwards: leftover entries would be noise in a
 * developer's checkout, and the "no jobs" test would never see an empty list.
 */
const created: string[] = [];

afterEach(() => {
  for (const id of created.splice(0)) {
    for (const path of [jobJsonPath(REPO_ROOT, id), jobLogPath(REPO_ROOT, id)]) {
      rmSync(path, { force: true });
    }
  }
});

const track = (message: string): string => {
  const id = idOf(message);
  created.push(id);
  return id;
};

/** Poll until `status` stops reporting `running`, rather than sleeping a guess. */
const settled = async (call: ToolCall, job: string, budgetMs = 5_000): Promise<string> => {
  for (let waited = 0; waited < budgetMs; waited += 50) {
    const status = await call({ action: 'status', params: { job } });
    const body = text(status);
    if (!body.includes('running')) {
      return body;
    }
    await sleep(50);
  }
  throw new Error(`job ${job} never left the running state`);
};

interface RegisteredTool {
  name: string;
  description: string;
  execute: (
    toolCallId: string,
    rawParams: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
}

/** One dispatched call, as `load()` hands it back. */
type ToolCall = (params: unknown) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

/**
 * Load the tool once per test.
 *
 * The extension resolves its repository root from `import.meta.url`, so its jobs
 * land in the real `.pi/background-tasks/` rather than in `root`. That is what a
 * real session does too, and the directory is gitignored — so the tests read the
 * journal from there and clean up the ids they created.
 */
const load = () => {
  const tools: RegisteredTool[] = [];
  devProcessExtension({
    registerTool: (t: RegisteredTool) => void tools.push(t),
  } as unknown as ExtensionAPI);
  const tool = tools[0];
  if (tool === undefined) {
    throw new Error('dev_process registered no tool');
  }
  return { tool, call: (params: unknown): ToolCallPromise => tool.execute('t1', params) };
};

type ToolCallPromise = ReturnType<RegisteredTool['execute']>;

const text = (result: Awaited<ReturnType<RegisteredTool['execute']>>): string =>
  result.content.map((part) => part.text).join('\n');

/** The job id `start` reported, so each test can clean up after itself. */
const idOf = (message: string): string => {
  const match = /job:\s+(\S+)/.exec(message);
  if (match?.[1] === undefined) {
    throw new Error(`no job id in: ${message}`);
  }
  return match[1];
};

describe('starting a job', () => {
  test('returns a handle and a log path immediately, without waiting', async () => {
    const bin = fakeBin('server', 'echo "listening"\nsleep 20');
    const { call } = load();

    const started = Date.now();
    const result = await call({ action: 'start', params: { args: [bin.path] } });
    const elapsed = Date.now() - started;

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('Started');
    expect(elapsed).toBeLessThan(5_000);
    // And it says plainly that nothing has been verified yet, so a model cannot
    // read "Started" as "working".
    expect(text(result)).toContain('has not verified anything yet');

    const job = idOf(text(result));
    await call({ action: 'stop', params: { job } });
  }, 30_000);

  test('explicit argv reaches the child intact', async () => {
    // Splitting on whitespace is what turns a quoted path containing a space into
    // two arguments and a confusing failure.
    const bin = fakeBin('argv', 'echo "argc=$#"');
    const { call } = load();

    const result = await call({
      action: 'start',
      params: { args: [bin.path, 'one', 'two'] },
    });
    const job = track(text(result));

    // Wait for the real exit. Reading the log of a process that has not written
    // yet would return an empty log and prove nothing about argv handling.
    await settled(call, job);

    const logs = await call({ action: 'logs', params: { job } });
    expect(text(logs)).toContain('argc=2');
  }, 30_000);

  test('a spawn failure is recorded as failed, with no exit code of 0 anywhere', async () => {
    // The spawn error arrives asynchronously on the child, so `start` legitimately
    // reports success — the job exists. What must not happen is the failure being
    // lost or softened into a clean exit.
    const { call } = load();

    const result = await call({
      action: 'start',
      params: { args: ['/nonexistent/not-a-real-binary'] },
    });
    const job = track(text(result));

    const body = await settled(call, job);

    expect(body).toContain('failed');
    expect(body).not.toContain('exited');

    const logs = await call({ action: 'logs', params: { job } });
    expect(text(logs)).toContain('spawn failed');
  }, 30_000);
});

describe('silence is never completion', () => {
  test('a job that prints nothing is still reported as running', async () => {
    // The mistake this exists to prevent: a linking phase that has emitted nothing
    // for a while, read as a finished build.
    const bin = fakeBin('quiet', 'sleep 20');
    const { call } = load();

    const started = await call({ action: 'start', params: { args: [bin.path] } });
    const job = idOf(text(started));
    await sleep(700);

    const status = await call({ action: 'status', params: { job } });
    expect(text(status)).toContain('running');
    expect(text(status)).toContain('It is still running');
    // The sentence that makes the rule unusable to misinterpret.
    expect(text(status)).toContain('NOT completion');

    await call({ action: 'stop', params: { job } });
  }, 30_000);

  test('logs on a running job say the result has not arrived', async () => {
    const bin = fakeBin('quiet', 'sleep 20');
    const { call } = load();

    const started = await call({ action: 'start', params: { args: [bin.path] } });
    const job = idOf(text(started));
    await sleep(400);

    const logs = await call({ action: 'logs', params: { job } });
    expect(text(logs)).toContain('still running');
    expect(text(logs)).toContain('not its result');

    await call({ action: 'stop', params: { job } });
  }, 30_000);

  test('an empty log is reported as empty, not as a clean run', async () => {
    const bin = fakeBin('silent', 'sleep 20');
    const { call } = load();

    const started = await call({ action: 'start', params: { args: [bin.path] } });
    const job = idOf(text(started));
    await sleep(400);

    const logs = await call({ action: 'logs', params: { job } });
    // "The log is empty" and "the job printed nothing and finished" are different
    // claims, and only the second one is a result.
    expect(text(logs)).toContain('log is empty');
    expect(text(logs)).toContain('not a clean run');

    await call({ action: 'stop', params: { job } });
  }, 30_000);
});

describe('status', () => {
  test('a finished job reports its exit code', async () => {
    const bin = fakeBin('done', 'exit 3');
    const { call } = load();

    const started = await call({ action: 'start', params: { args: [bin.path] } });
    const job = idOf(text(started));

    // Wait for the real exit rather than sleeping a guessed interval.
    for (let waited = 0; waited < 5_000; waited += 50) {
      const status = await call({ action: 'status', params: { job } });
      if (!text(status).includes('running')) {
        expect(text(status)).toContain('failed');
        expect(text(status)).toContain('exit 3');
        return;
      }
      await sleep(50);
    }
    throw new Error(`job ${job} never reported a finished state`);
  }, 30_000);

  test('an unknown job id is refused, with the list to use instead', async () => {
    const { call } = load();
    const result = await call({ action: 'status', params: { job: 'job-does-not-exist' } });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No job with id');
    expect(text(result)).toContain('no job');
  }, 30_000);

  test('the list states how many are running, so running is never read as passed', async () => {
    // Not "no jobs recorded": this file shares the journal with a real session, so
    // asserting emptiness would depend on what else ran first. The invariant worth
    // pinning is that every row carries its state and exit code, and that the count
    // of running jobs is stated separately from the total.
    const bin = fakeBin('server', 'sleep 20');
    const { call } = load();

    const started = await call({ action: 'start', params: { args: [bin.path] } });
    const job = track(text(started));
    await sleep(300);

    const result = await call({ action: 'status', params: {} });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/\d+ job\(s\), \d+ running:/);
    // Every listed row states a state, so no row can be read as a pass by omission.
    for (const line of text(result)
      .split('\n')
      .filter((l) => l.includes('job-'))) {
      expect(line).toMatch(/job-\S+\s+(running|exited|failed|killed)/);
    }

    await call({ action: 'stop', params: { job } });
  }, 30_000);
});

describe('stopping', () => {
  test('a stop is not reported as a process failure', async () => {
    // Exit 124 is a kill. Reading it as a test failure sends someone looking for a
    // bug in the application that was never there.
    const bin = fakeBin('server', 'sleep 30');
    const { call } = load();

    const started = await call({ action: 'start', params: { args: [bin.path] } });
    const job = idOf(text(started));
    await sleep(300);

    const stopped = await call({ action: 'stop', params: { job } });

    expect(stopped.isError).toBeFalsy();
    expect(text(stopped)).toContain('Stopped');
    expect(text(stopped)).toContain('124');
    expect(text(stopped)).toContain('not a failure');
  }, 30_000);

  test('stopping an already-finished job says what it exited with', async () => {
    const bin = fakeBin('done', 'exit 4');
    const { call } = load();

    const started = await call({ action: 'start', params: { args: [bin.path] } });
    const job = idOf(text(started));
    await sleep(600);

    const stopped = await call({ action: 'stop', params: { job } });

    expect(stopped.isError).toBe(true);
    expect(text(stopped)).toContain('already finished');
    expect(text(stopped)).toContain('4');
  }, 30_000);

  test('an unknown job id is refused rather than silently succeeding', async () => {
    const { call } = load();
    const result = await call({ action: 'stop', params: { job: 'job-nope' } });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no job with id');
  }, 30_000);
});

describe('the journal', () => {
  test('a job is recorded on disk, so a dead session leaves a usable record', async () => {
    // The point of the journal: a session that dies mid-build leaves a record
    // saying the job is running, rather than a process nobody knows about.
    const bin = fakeBin('done', 'echo ready\nexit 0');
    const { call } = load();

    const started = await call({ action: 'start', params: { args: [bin.path] } });
    const job = track(text(started));
    await settled(call, job);

    const dir = jobDir(REPO_ROOT);
    expect(existsSync(join(dir, `${job}.json`))).toBe(true);
    expect(existsSync(join(dir, `${job}.log`))).toBe(true);
    // And the log holds the whole stream, not just a bounded tail.
    expect(readFileSync(join(dir, `${job}.log`), 'utf8')).toContain('ready');
  }, 30_000);

  test('the recorded command and cwd are the ones actually used', async () => {
    // A journal entry is evidence about a process. If it recorded the tool's
    // defaults rather than what ran, it could not be used to diagnose anything.
    const bin = fakeBin('echoer', 'exit 0');
    const { call } = load();

    const started = await call({ action: 'start', params: { args: [bin.path] } });
    const job = track(text(started));
    await settled(call, job);

    const snapshot = JSON.parse(readFileSync(join(jobDir(REPO_ROOT), `${job}.json`), 'utf8')) as {
      command: string;
      args: string[];
      cwd: string;
      exitCode: number;
    };

    expect(snapshot.command).toBe(bin.path);
    expect(snapshot.cwd).toBe(REPO_ROOT);
    expect(snapshot.exitCode).toBe(0);
  }, 30_000);
});
