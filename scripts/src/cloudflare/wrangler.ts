// scripts/src/cloudflare/wrangler.ts
//
// The only place that shells out to Wrangler.
//
// One wrapper so that "is wrangler available", "which version", "which config",
// and "are we allowed to touch a remote" are decided in one file rather than at
// each of the dozen call sites. Every remote operation goes through
// `requireRemoteConsent`.
//
// Two invariants this module owns, both of which were violated before:
//
//   1. **The binary is the pinned one.** It resolves through `tools.wranglerBin()`,
//      never through `bunx`. See that module for why `bunx` is wrong here.
//   2. **`wrangler` appears in argv exactly once.** The plan builder emits the
//      subcommand and its arguments *without* the `wrangler` token; this module
//      prepends the binary. When the plan also included it, the process that
//      actually ran was `wrangler wrangler deploy`, which fails with a message
//      that names neither the plan nor the cause.

import { spawn, spawnSync } from 'node:child_process';
import { killTree } from '@starter/utils/process';
import { CLIENT_DIR, REPO_ROOT } from '../shared/paths.ts';
import { missingToolMessage, wranglerBin } from '../shared/tools.ts';

export { CLIENT_DIR, REPO_ROOT };

/**
 * Why wrangler is unusable, or `null` when it is usable.
 *
 * A reason rather than a boolean: the caller has to tell the operator what to do
 * about it, and the two failure modes (not installed / installed but broken) have
 * different remedies.
 */
export const wranglerUnavailableReason = (): string | null => {
  const bin = wranglerBin();
  if (bin === null) {
    return missingToolMessage('wrangler', 'apps/frontend/client');
  }

  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', cwd: REPO_ROOT });
  if (probe.error !== undefined || probe.status !== 0) {
    const detail = probe.error?.message ?? probe.stderr?.trim() ?? 'unknown error';
    return `\`${bin} --version\` failed (${detail}). Run \`bun install\` and try again.`;
  }

  return null;
};

/** Is `wrangler` usable? Cheap check; does not contact the network. */
export const wranglerAvailable = (): boolean => wranglerUnavailableReason() === null;

/** The pinned wrangler version, as the binary reports it. */
export const wranglerVersion = (): string | null => {
  const bin = wranglerBin();
  if (bin === null) {
    return null;
  }
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', cwd: REPO_ROOT });
  return probe.status === 0 ? probe.stdout.trim() : null;
};

/**
 * Is a Cloudflare credential present? Never prints it.
 *
 * Only `CLOUDFLARE_API_TOKEN` is treated as a credential. `wrangler login` writes
 * an OAuth token into a per-user config directory, and this function deliberately
 * does not go looking for it: reading a developer's global wrangler state from a
 * script makes behaviour depend on machine state nobody can see in review. When
 * only the OAuth login exists, this reports "no credential" and the operator sets
 * the variable or exports the token. Phase 3 makes the supported paths explicit.
 */
export const hasCloudflareCredential = (): boolean => {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  return token !== undefined && token.trim().length > 0;
};

export type RemoteConsent = { allowed: true } | { allowed: false; reason: string };

/**
 * Gate every remote mutation.
 *
 * `--yes` is the only thing that authorises a remote mutation, in every session.
 * An interactive terminal is *not* sufficient: the description this function used
 * to carry claimed it refused "a non-interactive process, or one without
 * `--yes`", which meant an interactive shell without `--yes` proceeded silently.
 * That is the worse behaviour — the operator gets no prompt and no signal that
 * consent was assumed rather than given.
 *
 * `interactive` is a parameter so the caller can prove the behaviour at the
 * process boundary in a test rather than by reading this comment.
 */
export const requireRemoteConsent = (
  target: string,
  args: readonly string[],
  interactive: boolean = process.stdout.isTTY === true && process.env.CI !== 'true',
): RemoteConsent => {
  if (!hasCloudflareCredential()) {
    return {
      allowed: false,
      reason:
        'No Cloudflare credential found. Set CLOUDFLARE_API_TOKEN (this is the only ' +
        'credential this tooling reads). Nothing has been changed.',
    };
  }

  if (!args.includes('--yes')) {
    return {
      allowed: false,
      reason:
        `Refusing to modify ${target} without --yes.` +
        (interactive ? '' : ' (This session is non-interactive, so there is nobody to ask.)') +
        ' Use --dry-run to see exactly what would run. Nothing has been changed.',
    };
  }

  return { allowed: true };
};

/** Optional per-call options, for commands that need to bound or observe output. */
export interface RunOptions {
  cwd?: string;
}

/**
 * How a wrangler invocation is executed. Injectable so tests can observe argv at
 * the process boundary instead of asserting on a constant array.
 */
export interface ProcessRunner {
  run(command: string, args: readonly string[], options: { cwd: string }): number;
}

const defaultRunner: ProcessRunner = {
  run: (command, args, options) =>
    spawnSync(command, [...args], { stdio: 'inherit', cwd: options.cwd }).status ?? 1,
};

/** Injected by `main`/tests; defaults to the real process. */
let runner: ProcessRunner = defaultRunner;

export const setProcessRunner = (next: ProcessRunner | null): void => {
  runner = next ?? defaultRunner;
};

/**
 * Run wrangler. Never throws; returns the exit code.
 *
 * `wranglerArgs` must NOT include the `wrangler` token. This function supplies
 * the binary and prepends nothing else.
 */
export const runWrangler = (
  wranglerArgs: readonly string[],
  options: { cwd?: string } = {},
): number => {
  const bin = wranglerBin();
  if (bin === null) {
    process.stderr.write(`${missingToolMessage('wrangler', 'apps/frontend/client')}\n`);
    return 1;
  }
  return runner.run(bin, wranglerArgs, { cwd: options.cwd ?? REPO_ROOT });
};

/** How a streaming invocation is executed. Separate from `ProcessRunner` because
 * it is asynchronous and line-oriented, and a synchronous runner cannot express
 * "read each line as it arrives, stop after N milliseconds". */
export interface StreamRunner {
  run(
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number },
    handlers: { onStdout: (line: string) => void; onStderr: (line: string) => void },
  ): Promise<number>;
}

/**
 * The real streaming runner.
 *
 * Exported so the framing and the timeout can be driven against a real child
 * process — `sh`, in practice — rather than through `streamWrangler`, which always
 * spawns wrangler. The framing bug is only reachable when the pipe actually
 * splits a line mid-way, and a mock decides for itself where the chunk ends.
 */
export const defaultStreamRunner: StreamRunner = {
  run: (command, args, options, handlers) =>
    new Promise<number>((resolve) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Lines are split here rather than by the caller, and the trailing partial
      // line is carried to the next chunk.
      //
      // A chunk boundary lands wherever the pipe buffer fills, not on a newline, so
      // splitting each chunk on its own emits fragments: `{"outcome":"succ` and
      // `ess",...}`. The NDJSON envelope then failed to parse and the event was
      // dropped, which for a JSON stream is most of them. The remainder is held
      // until the next chunk completes the line, and flushed at end/close so a final
      // line with no trailing newline still reaches the handler instead of being
      // buffered forever waiting for one that never comes.
      const lineSplitter = (
        emit: (line: string) => void,
      ): ((chunk: Buffer) => void) & {
        flush: () => void;
      } => {
        let carry = '';

        const handle = (chunk: Buffer): void => {
          const lines = (carry + chunk.toString('utf8')).split('\n');
          // The last element is '' when the chunk ended on a newline, and an
          // incomplete line otherwise. Only the incomplete one is carried.
          carry = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim() !== '') {
              emit(line);
            }
          }
        };

        handle.flush = (): void => {
          const rest = carry;
          carry = '';
          if (rest.trim() !== '') {
            emit(rest);
          }
        };

        return handle;
      };

      const onStdoutChunk = lineSplitter(handlers.onStdout);
      const onStderrChunk = lineSplitter(handlers.onStderr);

      child.stdout?.on('data', onStdoutChunk);
      child.stderr?.on('data', onStderrChunk);

      // `end` is the ordered half-close; `close` is the belt-and-braces one, since
      // a stream that never ends cleanly can still close. `flush` clears its carry
      // on the first call, so running twice is harmless.
      child.stdout?.on('end', onStdoutChunk.flush);
      child.stderr?.on('end', onStderrChunk.flush);
      child.stdout?.on('close', onStdoutChunk.flush);
      child.stderr?.on('close', onStderrChunk.flush);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Kill the tree, not just wrangler: workerd is its child and would
        // otherwise keep the port.
        if (child.pid !== undefined) {
          killTree(child.pid, { graceMs: 200, attempts: 10 });
        }
      }, options.timeoutMs);

      child.on('error', (error) => {
        clearTimeout(timer);
        handlers.onStderr(error.message);
        resolve(1);
      });

      child.on('exit', (code) => {
        clearTimeout(timer);
        // A process killed because *we* ran out of time reports success by the only
        // signal it has left — a SIGTERM has no exit code. Resolving that as 0
        // tells the caller the tail ran to completion and printed everything, which
        // is the opposite of what happened, and `--follow --duration 60s` would
        // read as a clean finish rather than a truncated stream. Reported as
        // failure with the timeout named.
        //
        // Only when the exit *follows* the timeout: a run that finished first keeps
        // its own code, because that is a real answer about the command.
        resolve(timedOut ? 1 : (code ?? 1));
      });
    }),
};

let streamRunner: StreamRunner = defaultStreamRunner;

export const setStreamRunner = (next: StreamRunner | null): void => {
  streamRunner = next ?? defaultStreamRunner;
};

/**
 * The binary the stream runner is handed. Overridable so a test can drive the
 * streaming path on a host where wrangler is not installed.
 *
 * `streamWrangler` refuses before reaching the runner when `wranglerBin()` is null,
 * which is right in production and useless in a test: it means the injected runner
 * is never called and the caller is told "wrangler is missing" instead of the
 * behaviour under test. So the *binary* is the seam, not just the runner.
 */
let streamBinaryOverride: string | null = null;

export const setStreamBinary = (next: string | null): void => {
  streamBinaryOverride = next;
};

/** Resolve the streaming binary, honouring any override. */
export const streamBinary = (): string | null => streamBinaryOverride ?? wranglerBin();

/**
 * Run wrangler as a bounded stream.
 *
 * `wranglerArgs` must NOT include the `wrangler` token, for the same reason as
 * `runWrangler`: this function supplies the binary.
 *
 * Always resolves — the timeout is enforced here rather than by the caller
 * remembering to, because a forgotten `--follow` that holds a port breaks the next
 * command the way an unbounded dev server does.
 */
export const streamWrangler = (
  wranglerArgs: readonly string[],
  options: { cwd?: string; timeoutMs: number } & {
    onStdout: (line: string) => void;
    onStderr: (line: string) => void;
  },
): Promise<number> => {
  const bin = streamBinary();
  if (bin === null) {
    options.onStderr(missingToolMessage('wrangler', 'apps/frontend/client'));
    return Promise.resolve(1);
  }
  return streamRunner.run(
    bin,
    wranglerArgs,
    { cwd: options.cwd ?? REPO_ROOT, timeoutMs: options.timeoutMs },
    { onStdout: options.onStdout, onStderr: options.onStderr },
  );
};

/**
 * Run wrangler and capture stdout, for parsing.
 *
 * Used for read-only inspection (validating a config, listing migrations). Never
 * used for a mutation.
 */
export const captureWrangler = (
  wranglerArgs: readonly string[],
): { ok: boolean; stdout: string; stderr: string } => {
  const bin = wranglerBin();
  if (bin === null) {
    return {
      ok: false,
      stdout: '',
      stderr: missingToolMessage('wrangler', 'apps/frontend/client'),
    };
  }

  const result = spawnSync(bin, [...wranglerArgs], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};
