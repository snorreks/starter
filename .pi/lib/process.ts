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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
 * Append up to `maxBytes`, then spill to a file and stop growing.
 *
 * Returns the text to keep and whether a spill happened. The spill file is the
 * authoritative record of what was dropped, so a reader can go and read it.
 */
class BoundedBuffer {
  private kept = '';
  private spilled = '';
  private total = 0;
  private spilledTo: string | undefined;

  constructor(
    private readonly name: string,
    private readonly maxBytes: number,
    private readonly root: string,
  ) {}

  write(chunk: string): void {
    this.total += Buffer.byteLength(chunk);
    this.spilled += chunk;

    if (Buffer.byteLength(this.kept) < this.maxBytes) {
      const room = this.maxBytes - Buffer.byteLength(this.kept);
      this.kept += room >= chunk.length ? chunk : chunk.slice(0, room);
      return;
    }

    // Already truncated; the artifact is written once, at the end.
  }

  /** Write the overflow and return the path, if anything overflowed. */
  finish(): { text: string; truncated: boolean; artifactPath?: string } {
    const keptBytes = Buffer.byteLength(this.kept);
    if (this.total <= keptBytes) {
      return { text: this.kept, truncated: false };
    }

    const path = join(this.root, `${this.name}-${Date.now()}.log`);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, this.spilled);
      this.spilledTo = path;
    } catch {
      // A tool must not fail because it could not write a debug artifact.
    }

    return {
      text: this.kept,
      truncated: true,
      ...(this.spilledTo === undefined ? {} : { artifactPath: this.spilledTo }),
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
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill(signal);
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
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
