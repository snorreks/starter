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
}): Promise<BoundedResult> =>
  new Promise((resolve) => {
    // A group outlives its launcher. A reparented child retaining the pipes must
    // still be stoppable after the launcher's exit, not just while its PID exists.
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    let bytes = 0;
    let stdout = '';
    let stderr = '';
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
        stdout,
        stderr: `${stderr}${problem === undefined ? '' : `\n${problem}`}`,
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
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null);
      }, 250);
    };
    const append = (options: { chunk: Buffer; error: boolean }): void => {
      const text = options.chunk.subarray(0, Math.max(0, maxBytes - bytes)).toString('utf8');
      bytes += options.chunk.length;
      if (options.error) {
        stderr += text;
      } else {
        stdout += text;
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
    child.stdout.on('data', (chunk: Buffer) => append({ chunk, error: false }));
    child.stderr.on('data', (chunk: Buffer) => append({ chunk, error: true }));
    child.on('error', (error) => {
      problem = error.message;
    });
    child.on('close', finish);
    child.stdin.on('error', () => stop('Child stdin closed before input was accepted.'));
    child.stdin.end(options.input);
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
}): BoundedResult => {
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), options.command, ...options.args],
    {
      cwd: options.cwd,
      input: options.input ?? '',
      env: {
        ...(options.env ?? process.env),
        STARTER_PROCESS_TIMEOUT_MS: String(timeoutMs),
        STARTER_PROCESS_MAX_BYTES: String(maxBytes),
      },
      encoding: 'utf8',
      timeout: timeoutMs + 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: maxBytes + 4096,
    },
  );
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error === undefined ? '' : `\nSupervisor failed: ${result.error.message}`}`,
  };
};

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) {
    process.stderr.write('Missing supervised command.\n');
    process.exitCode = 2;
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
