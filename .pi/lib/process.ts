// .pi/lib/process.ts
//
// A bounded, cancellable subprocess runner.
//
// Every tool that shells out needs the same four things, and getting them wrong
// is how a tool hangs or exhausts memory:
//
//   1. **A byte limit.** A `limit: 200` argument bounds *lines*, not bytes, and
//      bounds what the CLI decides to emit — not what the process writes. A
//      process that writes 400 MB of progress output while producing two useful
//      lines is not bounded by a line count.
//   2. **A real timeout.** `--follow` with no end is not a command.
//   3. **Cancellation.** The caller has to be able to stop waiting.
//   4. **An exit status.** A tool that cannot tell a failure from a hang reports
//      the hang.
//
// Output beyond the byte limit is not simply discarded: the tail is written to a
// file and the caller is told where. A tool that silently drops the interesting
// part is worse than one that says where to look.

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export interface BoundedRunOptions {
  cwd: string;
  /** Milliseconds before the child is SIGTERMed, then SIGKILLed. */
  timeoutMs: number;
  /** Bytes of stdout/stderr kept in memory. */
  maxBytes: number;
  /** Extra grace between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  /** Called with an AbortSignal the caller can trigger. */
  signal?: AbortSignal;
  /** Where to spill overflow. Defaults under `.pi/artifacts/`. */
  artifactRoot?: string;
}

export interface BoundedRunResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  artifactPath?: string;
  timedOut: boolean;
  cancelled: boolean;
}

const ARTIFACT_ROOT = join(process.cwd(), '.pi', 'artifacts');

/**
 * Split a chunk at a byte boundary, never inside a character.
 *
 * A byte count is not a character count: `slice` cuts at UTF-16 code units, so
 * slicing a multibyte chunk at a byte offset either overruns the limit or splits a
 * character in half — and the half reads back as U+FFFD. So the boundary is
 * measured in bytes and only complete characters before it are kept; the rest
 * goes to the artifact.
 */
const splitAtBytes = (chunk: string, maxBytes: number): { head: string; rest: string } => {
  if (Buffer.byteLength(chunk) <= maxBytes) {
    return { head: chunk, rest: '' };
  }

  let used = 0;
  let units = 0;
  for (const character of chunk) {
    const size = Buffer.byteLength(character);
    if (used + size > maxBytes) {
      break;
    }
    used += size;
    units += character.length;
  }
  return { head: chunk.slice(0, units), rest: chunk.slice(units) };
};

/**
 * Keep up to `maxBytes` in memory; stream the rest to the artifact file.
 *
 * The overflow used to be accumulated in a second string and written once at the
 * end, which is not a bound at all: a child that writes 400 MB kept 400 MB here
 * plus a second copy during the write. The file is the authoritative record of
 * what was dropped, so a reader can go and read it, and it is now written as the
 * output arrives rather than after it.
 */
class BoundedBuffer {
  private kept = '';
  private total = 0;
  /** Open handle to the overflow file, once the limit has been passed. */
  private fd: number | null = null;
  /** Set when the artifact could not be opened, so it is not retried per chunk. */
  private spillAttempted = false;
  private spilledTo: string | undefined;

  constructor(
    private readonly name: string,
    private readonly maxBytes: number,
    private readonly root: string,
  ) {}

  write(chunk: string): void {
    this.total += Buffer.byteLength(chunk);

    if (this.fd !== null) {
      this.append(chunk);
      return;
    }
    if (this.spillAttempted) {
      // The artifact could not be opened. The in-memory text is still capped, and
      // the run still reports that output was dropped.
      return;
    }

    const { head, rest } = splitAtBytes(chunk, this.maxBytes - Buffer.byteLength(this.kept));
    this.kept += head;
    if (rest.length === 0) {
      return;
    }
    this.spillAttempted = true;

    try {
      mkdirSync(this.root, { recursive: true });
      const path = join(this.root, `${this.name}-${Date.now()}.log`);
      this.fd = openSync(path, 'w');
      // The file is the whole stream, not just the tail, so it opens with what is
      // already in memory.
      writeSync(this.fd, this.kept);
      this.spilledTo = path;
    } catch {
      // A tool must not fail because it could not write a debug artifact.
      this.fd = null;
      return;
    }

    this.append(rest);
  }

  private append(chunk: string): void {
    if (this.fd === null) {
      return;
    }
    try {
      writeSync(this.fd, chunk);
    } catch {
      /* a debug artifact is not worth failing a run over */
    }
  }

  /** Close the artifact and report whether anything overflowed. */
  finish(): { text: string; truncated: boolean; artifactPath?: string } {
    const path = this.spilledTo;
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }

    if (this.total <= Buffer.byteLength(this.kept)) {
      return { text: this.kept, truncated: false };
    }

    return {
      text: this.kept,
      truncated: true,
      ...(path === undefined ? {} : { artifactPath: path }),
    };
  }
}

/**
 * Run a command with hard bounds.
 *
 * Never throws for a non-zero exit: the exit code is the answer. Throws only for
 * a spawn failure, which the caller usually wants to surface as a refusal.
 */
export const runBounded = (
  command: string,
  args: readonly string[],
  options: BoundedRunOptions,
): Promise<BoundedRunResult> => {
  const root = options.artifactRoot ?? ARTIFACT_ROOT;
  const killGraceMs = options.killGraceMs ?? 2_000;

  return new Promise<BoundedRunResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a kill reaches the whole tree.
      //
      // Signalling only the direct child is not enough, and the failure is
      // invisible on a laptop: `sh -c 'sleep 30'` under bash makes the shell
      // `exec` the sleep, so the signal lands on the only process and `close`
      // fires in 4 ms. Under dash — which is what `/bin/sh` is on Ubuntu, and
      // therefore on every GitHub runner — the shell forks instead, and the
      // orphaned `sleep` inherits the stdout pipe. `close` waits for that pipe,
      // so it never fires: the run hangs until the test framework kills it. That
      // is exactly what CI showed, with both timeout tests hitting 5000 ms while
      // the three tests that do not wait for a kill finished in 40 ms.
      //
      // Reproduced before fixing: with `sh` resolving to dash, `close` never
      // fired; with bash, it fired in 4 ms. `detached` plus a negative process
      // group is the portable form, and it is what makes the bound a bound
      // rather than a request.
      detached: true,
    });

    const stdoutBuffer = new BoundedBuffer(
      `${command.replace(/\W+/g, '_')}-stdout`,
      options.maxBytes,
      root,
    );
    const stderrBuffer = new BoundedBuffer(
      `${command.replace(/\W+/g, '_')}-stderr`,
      options.maxBytes,
      root,
    );

    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const kill = (signal: NodeJS.Signals): void => {
      // Whether *this run* is over, not whether the direct child exited. A
      // backgrounded descendant keeps the inherited stdout pipe open after the
      // child is gone — `sh -c 'sleep 30 &'` is the smallest example — and `close`,
      // the only event that settles this promise, waits on that pipe. Gating on
      // `child.exitCode` therefore made the timeout a request in precisely the
      // case it exists for: the SIGTERM was skipped, the SIGKILL timer skipped
      // too, and the run hung. `process.kill(-pid)` still reaches a group whose
      // leader has exited as long as members remain, and the catch handles ESRCH
      // for a group that is genuinely empty.
      if (settled) {
        return;
      }
      // `child.pid` is `undefined` only if the spawn failed, in which case the
      // `error` handler settles the promise and there is no process and no group
      // to signal; falling back to `child.kill` is then a no-op that cannot throw.
      const signalTree = (which: NodeJS.Signals): void => {
        if (child.pid === undefined) {
          child.kill(which);
          return;
        }
        try {
          process.kill(-child.pid, which);
        } catch {
          child.kill(which);
        }
      };

      signalTree(signal);

      // SIGKILL after the grace period, and SIGKILL specifically: a process that
      // ignored or is blocked on SIGTERM does not get a second SIGTERM, it gets
      // the one signal it cannot catch.
      setTimeout(() => {
        if (!settled) {
          signalTree('SIGKILL');
        }
      }, killGraceMs).unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
    }, options.timeoutMs);
    timer.unref?.();

    const onAbort = (): void => {
      cancelled = true;
      kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.on('data', (chunk: Buffer) => stdoutBuffer.write(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => stderrBuffer.write(chunk.toString('utf8')));

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      const stdout = stdoutBuffer.finish();
      const stderr = stderrBuffer.finish();

      resolve({
        // A process killed by a signal has no code; report a distinct one rather
        // than 0, so "timed out" never reads as "succeeded".
        code: code ?? (signal === null ? 0 : 124),
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
        ...(stdout.artifactPath === undefined && stderr.artifactPath === undefined
          ? {}
          : { artifactPath: stdout.artifactPath ?? stderr.artifactPath }),
        timedOut,
        cancelled,
      });
    });
  });
};
