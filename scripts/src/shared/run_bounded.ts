import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { killTree } from '@starter/utils/process';

/** A bounded process result; partial output is retained on failure. */
export interface BoundedResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Decode a whole stream at once.
 *
 * Two defects come from decoding each chunk as it arrives. A pipe boundary lands
 * wherever the kernel's buffer fills, which is routinely in the middle of a
 * multibyte character: `toString('utf8')` on a fragment decodes it to U+FFFD, so
 * one `é` written by a child became two replacement characters. And the byte
 * budget can cut the last character in half, which decodes to a replacement
 * character for bytes that were never a character at all.
 *
 * So the bytes are kept and decoded once. The trailing replacement characters are
 * dropped, and only the trailing ones: `Buffer.byteLength` of the decoded text is
 * shorter than the buffer exactly when the decoder gave up, and a genuinely
 * encoded U+FFFD re-encodes to the three bytes it came from.
 */
const decode = (chunks: readonly Buffer[], byteLength: number): string => {
  const text = Buffer.concat(chunks, byteLength).toString('utf8');
  return Buffer.byteLength(text, 'utf8') === byteLength ? text : text.replace(/\uFFFD+$/u, '');
};

/** Run argv without a shell, bounding time, output, cancellation and descendants. */
export const runBounded = (options: {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  input?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * `capture` (the default) bounds and returns the output. `inherit` hands the
   * child this process's terminal — live streams, and a stdin that can still
   * answer a prompt — and the returned strings are then empty because nothing is
   * buffered. The time bound applies either way.
   */
  stdio?: 'capture' | 'inherit';
}): Promise<BoundedResult> =>
  new Promise((resolve) => {
    // A group outlives its launcher. A reparented child retaining the pipes must
    // still be stoppable after the launcher's exit, not just while its PID exists.
    const inherit = options.stdio === 'inherit';
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: options.env,
      stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    let bytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let problem: string | undefined;
    let settled = false;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(settlementTimer);
      process.removeListener('SIGINT', interrupted);
      process.removeListener('SIGTERM', interrupted);
      options.signal?.removeEventListener('abort', interrupted);
      resolve({
        code: problem === undefined ? (code ?? 1) : 1,
        stdout: decode(stdoutChunks, stdoutBytes),
        stderr: `${decode(stderrChunks, stderrBytes)}${
          problem === undefined ? '' : `\n${problem}`
        }`,
      });
    };
    const stop = (reason: string): void => {
      if (problem !== undefined || settled) {
        return;
      }
      problem = reason;
      if (child.pid !== undefined) {
        if (process.platform === 'win32') {
          killTree(child.pid, { graceMs: 100, attempts: 10 });
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // The group may already have exited. Settlement must not depend on it.
          }
        }
      }
      settlementTimer = setTimeout(() => {
        // Null when the streams were inherited rather than piped; there is nothing
        // to tear down in that case, and the guard is what keeps that from being a
        // TypeError on the timeout path.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(null);
      }, 250);
    };
    const append = (options: { chunk: Buffer; error: boolean }): void => {
      const kept = options.chunk.subarray(0, Math.max(0, maxBytes - bytes));
      bytes += options.chunk.length;
      if (kept.length > 0) {
        if (options.error) {
          stderrChunks.push(kept);
          stderrBytes += kept.length;
        } else {
          stdoutChunks.push(kept);
          stdoutBytes += kept.length;
        }
      }
      if (bytes > maxBytes) {
        stop('Process exceeded its output budget.');
      }
    };
    const interrupted = (): void => stop('Process cancelled.');
    const timer = setTimeout(
      () => stop('Process exceeded its time budget.'),
      options.timeoutMs ?? 20 * 60_000,
    );
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    options.signal?.addEventListener('abort', interrupted, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => append({ chunk, error: false }));
    child.stderr?.on('data', (chunk: Buffer) => append({ chunk, error: true }));
    child.on('error', (error) => {
      problem = error.message;
    });
    child.on('close', finish);
    const stdin = child.stdin;
    if (!inherit && stdin !== null) {
      stdin.on('error', () => stop('Child stdin closed before input was accepted.'));
      stdin.end(options.input);
    }
    if (options.signal?.aborted) {
      interrupted();
    }
  });

/** Sync adapter for existing CLIs; the supervised child still owns its process group. */
export const runBoundedSync = (options: {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs?: number;
  maxBytes?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * `capture` (the default) bounds and returns the output. `inherit` hands the
   * child this process's terminal, so its streams stay live and it can be
   * prompted; the returned strings are then empty because nothing is buffered.
   */
  stdio?: 'capture' | 'inherit';
}): BoundedResult => {
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const inherit = options.stdio === 'inherit';
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), options.command, ...options.args],
    {
      cwd: options.cwd,
      input: inherit ? undefined : (options.input ?? ''),
      env: {
        ...(options.env ?? process.env),
        STARTER_PROCESS_TIMEOUT_MS: String(timeoutMs),
        STARTER_PROCESS_MAX_BYTES: String(maxBytes),
        ...(inherit ? { STARTER_PROCESS_STDIO: 'inherit' } : {}),
      },
      stdio: inherit ? 'inherit' : undefined,
      encoding: 'utf8',
      timeout: timeoutMs + 5_000,
      killSignal: 'SIGKILL',
      // A limit that is not applied is not a limit: Node's own default is 1 MiB,
      // and an inherited stream exceeds it without anyone noticing.
      maxBuffer: inherit ? undefined : maxBytes + 4096,
    },
  );
  return {
    code: result.status ?? 1,
    stdout: inherit ? '' : (result.stdout ?? ''),
    stderr: inherit
      ? ''
      : `${result.stderr ?? ''}${result.error === undefined ? '' : `\nSupervisor failed: ${result.error.message}`}`,
  };
};

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) {
    process.stderr.write('Missing supervised command.\n');
    process.exitCode = 2;
  } else if (process.env.STARTER_PROCESS_STDIO === 'inherit') {
    // The supervisor's own terminal is the child's: stdin is readable, output is
    // live, and the time bound is the only thing left to enforce.
    process.exitCode = (
      await runBounded({
        command,
        args,
        cwd: process.cwd(),
        stdio: 'inherit',
        timeoutMs: Number(process.env.STARTER_PROCESS_TIMEOUT_MS),
      })
    ).code;
  } else {
    const result = await runBounded({
      command,
      args,
      cwd: process.cwd(),
      input: readFileSync(0, 'utf8'),
      timeoutMs: Number(process.env.STARTER_PROCESS_TIMEOUT_MS),
      maxBytes: Number(process.env.STARTER_PROCESS_MAX_BYTES),
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code;
  }
}
