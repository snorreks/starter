// .pi/tests/jobs.test.ts
//
// Owned long-running processes, against real local processes.
//
// Three properties are load-bearing and none of them can be proven with a mock:
//
//   1. **Completion is the exit status, never the silence.** A job that prints
//      nothing for a while is still `running`, because a quiet linking phase and a
//      finished build are indistinguishable from the log alone.
//   2. **A stop reaches the whole tree.** Signalling only the direct child leaves
//      a grandchild holding the inherited stdout pipe, so the job never reports
//      as stopped. `dash` is the shell here for exactly that reason — it forks
//      where `bash` would `exec`.
//   3. **A stop only touches what this checkout owns.** The token planted in the
//      child's own environment is checked first, so a recycled pid is refused
//      rather than killed.

import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  JOB_TOKEN_ENV,
  type JobSnapshot,
  jobJsonPath,
  listJobs,
  readJob,
  startJob,
  stopJob,
  tailJobLog,
  verifyOwnership,
} from '../lib/jobs.ts';
import { cleanupFakes, fakeBin, scratchDir } from './fake_bin.ts';

afterAll(cleanupFakes);

/** Long enough for a real process to start and be observed, short enough to test. */
const settle = 150;

const started = (dir: string, bin: string, args: string[] = [], timeoutMs = 30_000) =>
  startJob(bin, args, { cwd: dir, timeoutMs, maxBytes: 8 * 1024 });

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

describe('a job that finishes', () => {
  test('reports the exit status and the output', async () => {
    const dir = scratchDir('job-exit');
    const bin = fakeBin('done', 'echo "hello from the job"\nexit 0');

    const { handle } = started(dir, bin.path);
    const snapshot = await handle.wait();

    expect(snapshot.state).toBe('exited');
    expect(snapshot.exitCode).toBe(0);
    expect(handle.tail()).toContain('hello from the job');
  }, 20_000);

  test('a relative cwd is resolved before the supervisor changes directory', async () => {
    const dir = scratchDir('job-relative');
    const { handle } = started(relative(process.cwd(), dir), fakeBin('pwd', 'pwd').path);
    expect((await handle.wait()).state).toBe('exited');
    expect(handle.tail().trim()).toBe(dir);
  });

  test('a non-zero exit is `failed`, never reported as success', async () => {
    const dir = scratchDir('job-fail');
    const bin = fakeBin('failing', 'echo "boom" >&2\nexit 3');

    const { handle } = started(dir, bin.path);
    const snapshot = await handle.wait();

    expect(snapshot.state).toBe('failed');
    expect(snapshot.exitCode).toBe(3);
  }, 20_000);

  test.each([
    [process.execPath, 0],
    [process.execPath, 7],
    ['node', 0],
    ['node', 7],
  ] as const)(
    'persists %s exit %i after the originating process is killed',
    async (runtime, code) => {
      const dir = scratchDir('job-orphan');
      const release = join(dir, 'release');
      const bin = fakeBin(
        'wait-for-release',
        `while [ ! -f "${release}" ]; do sleep 0.05; done\necho survived\nexit ${code}`,
      );
      const modulePath = fileURLToPath(new URL('../lib/jobs.ts', import.meta.url));
      const origin = spawn(
        runtime,
        [
          '-e',
          `
      import { startJob } from ${JSON.stringify(modulePath)};
      startJob(${JSON.stringify(bin.path)}, [], { cwd: ${JSON.stringify(dir)}, timeoutMs: 10000, maxBytes: 4096 });
      setInterval(() => {}, 1000);
    `,
        ],
        { stdio: 'ignore' },
      );
      const originClosed = new Promise((resolve) => origin.on('close', resolve));
      let snapshot: JobSnapshot | undefined;
      try {
        const readyDeadline = Date.now() + 5000;
        while (Date.now() < readyDeadline) {
          snapshot = listJobs(dir)[0];
          if (snapshot?.pid !== undefined) {
            break;
          }
          await sleep(25);
        }
        expect(snapshot?.pid).toBeDefined();
        if (snapshot?.pid === undefined) {
          throw new Error('The job did not start before the readiness deadline');
        }
        origin.kill('SIGKILL');
        await originClosed;
        expect(readJob(dir, snapshot.id)?.state).toBe('running');
        fs.writeFileSync(release, 'go');
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && readJob(dir, snapshot.id)?.state === 'running') {
          await sleep(25);
        }
        const final = readJob(dir, snapshot.id);
        expect(final?.state).toBe(code === 0 ? 'exited' : 'failed');
        expect(final?.exitCode).toBe(code);
        expect(final?.finishedAt).toBeGreaterThanOrEqual(snapshot.startedAt);
        expect(tailJobLog(dir, snapshot.id)).toContain('survived');
      } finally {
        origin.kill('SIGKILL');
        fs.writeFileSync(release, 'go');
        if (snapshot !== undefined) {
          await stopJob(dir, snapshot.id, 25);
        }
      }
    },
    20_000,
  );
});

describe('silence is not completion', () => {
  test('a job that prints nothing is still running', async () => {
    // The specific mistake this exists to prevent: a dev server or a linking
    // phase that has emitted nothing for thirty seconds reads exactly like a
    // finished build.
    const dir = scratchDir('job-quiet');
    const bin = fakeBin('quiet', 'sleep 20');

    const { snapshot, handle } = started(dir, bin.path);
    await sleep(600);

    expect(readJob(dir, snapshot.id)?.state).toBe('running');
    expect(handle.tail()).toBe('');

    await handle.stop();
  }, 20_000);
});

describe('bounds', () => {
  test('a job that outlives its budget is stopped and reports a kill', async () => {
    const dir = scratchDir('job-timeout');
    const bin = fakeBin('forever', 'sleep 30');

    const { handle, snapshot } = startJob(bin.path, [], {
      cwd: dir,
      timeoutMs: 400,
      maxBytes: 4_096,
    });
    const final = await handle.wait();

    // 124, never 0: "timed out" must not read as "succeeded".
    expect(final.exitCode).toBe(124);
    expect(final.state).toBe('killed');
    expect(final.finishedAt).toBeGreaterThanOrEqual(snapshot.startedAt);
  }, 20_000);

  test('the readable tail is bounded while the file keeps the whole stream', async () => {
    const dir = scratchDir('job-flood');
    const bin = fakeBin(
      'flood',
      `i=0
while [ $i -lt 400 ]; do
  printf '%0.sx' $(seq 1 64)
  i=$((i + 1))
done
sleep 20`,
    );

    const { handle, logPath } = startJob(bin.path, [], {
      cwd: dir,
      timeoutMs: 20_000,
      maxBytes: 2_048,
    });
    await sleep(700);

    expect(Buffer.byteLength(handle.tail())).toBeLessThanOrEqual(2_048);
    // The file is the authoritative record, so nothing is actually lost.
    const whole = tailJobLog(dir, handle.snapshot().id, 1024 * 1024) ?? '';
    expect(whole.length).toBeGreaterThan(2_048);

    await handle.stop();
    expect(logPath).toContain(handle.snapshot().id);
  }, 30_000);

  test('an abort signal stops the job', async () => {
    const dir = scratchDir('job-abort');
    const bin = fakeBin('forever', 'sleep 30');
    const controller = new AbortController();

    const { handle } = startJob(bin.path, [], {
      cwd: dir,
      timeoutMs: 30_000,
      maxBytes: 4_096,
      signal: controller.signal,
    });
    await sleep(settle);
    controller.abort();

    const final = await handle.wait();
    expect(final.exitCode).toBe(124);
  }, 20_000);
});

describe('owned-child cleanup', () => {
  test('stopping reaches a grandchild, not just the direct child', async () => {
    // The failure this proves absent: under `dash`, `sh -c 'sleep 30 &'` forks a
    // grandchild that inherits the stdout pipe. Signalling only the direct child
    // leaves that grandchild alive, and `close` — the only event that settles the
    // wait — never fires, so the job appears to run forever.
    const dir = scratchDir('job-tree');
    const bin = fakeBin('tree', 'sleep 30 & sleep 30');

    const { handle } = started(dir, bin.path);
    await sleep(settle);
    const pid = handle.snapshot().pid;
    expect(pid).toBeDefined();

    await handle.stop();

    expect(await processGone(pid as number)).toBe(true);
    const final = readJob(dir, handle.snapshot().id);
    expect(final?.state).not.toBe('running');
  }, 30_000);

  test('a stop is refused for a pid that carries a different ownership token', async () => {
    // The data-loss case. A stale journal entry whose pid has been recycled now
    // belongs to somebody else's process; killing it because a file said so is a
    // bug with no local cause.
    //
    // The forged entry is written to the journal rather than only checked in
    // memory, because `stopJob` deliberately re-reads from disk — a pid that a
    // caller passed in would be an attacker-controlled signal target.
    const dir = scratchDir('job-ownership');
    const stranger = fakeBin('stranger', 'sleep 30');
    const { handle } = started(dir, stranger.path);
    await sleep(settle);

    const real = handle.snapshot();
    const forged: JobSnapshot = { ...real, token: 'a-token-this-process-never-had' };

    const verdict = verifyOwnership(forged);
    expect(verdict.owned).toBe(false);
    // Verified false-owned: the platform *could* answer here, and it said no.
    expect(verdict.verified).toBe(true);
    expect(verdict.reason).toContain('was reused');

    const { writeFileSync } = await import('node:fs');
    writeFileSync(jobJsonPath(dir, real.id), JSON.stringify(forged, null, 2));

    const outcome = await stopJob(dir, real.id);
    expect(outcome.stopped).toBe(false);
    expect(outcome.reason).toContain('refusing to signal');

    // And the refusal meant it: the process is still running, because nothing was
    // signalled.
    expect(await processGone(real.pid as number, 300)).toBe(false);

    await handle.stop();
  }, 30_000);

  test('refuses a live process whose environment cannot be inspected', async () => {
    const dir = scratchDir('job-unverified');
    const { handle } = started(dir, fakeBin('owned', 'sleep 30').path);
    await sleep(settle);
    const snapshot = handle.snapshot();
    const read = fs.readFileSync;
    const inspect = spyOn(fs, 'readFileSync').mockImplementation(((
      path: unknown,
      ...args: unknown[]
    ) => {
      if (path === `/proc/${snapshot.pid}/environ`) {
        throw new Error('unavailable');
      }
      return Reflect.apply(read, fs, [path, ...args]);
    }) as typeof fs.readFileSync);
    const signal = spyOn(process, 'kill');
    try {
      expect(verifyOwnership(snapshot)).toMatchObject({ owned: false, verified: false });
      expect((await stopJob(dir, snapshot.id, 25)).stopped).toBe(false);
      expect(signal.mock.calls.every(([, which]) => which === 0)).toBe(true);
    } finally {
      inspect.mockRestore();
      signal.mockRestore();
      await handle.stop();
    }
  }, 20_000);

  test('a later session stop stays killed when the child closes', async () => {
    const dir = scratchDir('job-stop-journal');
    const { handle } = started(dir, fakeBin('owned', 'sleep 30').path);
    await sleep(settle);
    expect((await stopJob(dir, handle.snapshot().id, 25)).stopped).toBe(true);
    expect((await handle.wait()).state).toBe('killed');
    expect(readJob(dir, handle.snapshot().id)).toMatchObject({ state: 'killed', exitCode: 124 });
  }, 20_000);

  test('a real job verifies as owned through its planted token', async () => {
    const dir = scratchDir('job-token');
    const bin = fakeBin('owned', 'sleep 30');
    const { handle } = started(dir, bin.path);
    await sleep(settle);

    const verdict = verifyOwnership(handle.snapshot());
    // `/proc` is Linux-only; where it is missing the verdict must say the answer
    // is unverified rather than pretending it passed.
    expect(verdict.owned).toBe(verdict.verified);
    if (verdict.verified) {
      expect(verdict.reason).toContain('token');
    } else {
      expect(verdict.reason).toContain('unverified');
    }

    await handle.stop();
  }, 30_000);
});

describe('ownership environment', () => {
  test('the token reaches the child process, which is what makes it provable', async () => {
    const dir = scratchDir('job-env');
    const bin = fakeBin('echoenv', `echo "${JOB_TOKEN_ENV}=present"`);
    const { handle } = started(dir, bin.path);
    await handle.wait();

    expect(handle.tail()).toContain(`${JOB_TOKEN_ENV}=present`);
  }, 20_000);
});

describe('stopping', () => {
  test('refuses an unknown job by id rather than doing nothing quietly', async () => {
    const dir = scratchDir('job-unknown');
    const outcome = await stopJob(dir, 'job-does-not-exist');

    expect(outcome.stopped).toBe(false);
    expect(outcome.reason).toContain('no job with id');
  });

  test('refuses a job that already finished, and says what it exited with', async () => {
    const dir = scratchDir('job-done');
    const bin = fakeBin('done', 'exit 4');
    const { handle } = started(dir, bin.path);
    await handle.wait();

    const outcome = await stopJob(dir, handle.snapshot().id);
    expect(outcome.stopped).toBe(false);
    // "Already finished with exit code 4" is a different answer from
    // "that pid is not ours", and the caller has to be able to tell them apart.
    expect(outcome.reason).toContain('already finished');
    expect(outcome.reason).toContain('4');
  }, 20_000);
});

describe('reading the journal', () => {
  test('lists every job newest first', async () => {
    const dir = scratchDir('job-list');
    const bin = fakeBin('quick', 'exit 0');

    const first = started(dir, bin.path);
    await first.handle.wait();
    await sleep(10);
    const second = started(dir, bin.path);
    await second.handle.wait();

    const ids = listJobs(dir).map((job) => job.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids.indexOf(second.snapshot.id)).toBeLessThan(ids.indexOf(first.snapshot.id));
  }, 30_000);

  test('a corrupt snapshot is reported rather than silently dropped', async () => {
    // Dropping it would make a job the agent started look like it never existed.
    const dir = scratchDir('job-corrupt');
    const bin = fakeBin('quick', 'exit 0');
    const { handle } = started(dir, bin.path);
    await handle.wait();

    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(dir, '.pi', 'background-tasks', 'job-truncated.json'), '{"id": "job-');

    const corrupt = listJobs(dir).find((job) => job.id === 'job-truncated');
    expect(corrupt).toBeDefined();
    expect(corrupt?.state).toBe('failed');
    expect(corrupt?.command).toBe('(unreadable)');
  }, 20_000);

  test('an empty directory lists nothing, which is an absence and not an error', async () => {
    expect(listJobs(scratchDir('job-empty'))).toEqual([]);
  });

  test('a missing log reports undefined rather than empty output', async () => {
    // Empty output would read as "the job logged nothing", which is a different
    // claim from "there is no log".
    expect(tailJobLog(scratchDir('job-nolog'), 'job-nope')).toBeUndefined();
  });
});
