// scripts/src/dev-api.ts
//
//   bun run dev:api
//
// Run the Worker locally and capture its log stream to a file.
//
// This replaced `apps/backend/api/scripts/dev-worker.sh`, which was a second
// implementation of the same operation. The two disagreed about the port, about
// where the log went, and about teardown, so a command that worked from the
// repository root failed from the API directory. There is one implementation now.
//
// Ownership, which is the part a shell script got wrong:
//
//   * **Per-checkout, not per-machine.** State lives in this checkout's
//     `.wrangler/`, never in a shared `/tmp` path. Two worktrees on one machine
//     each run their own Worker; the old script's `/tmp/starter-wrangler.pid`
//     meant the second worktree killed the first one's server.
//   * **Owned, not pattern-killed.** Only the process this run started, and its
//     descendants, are ever signalled. Nothing matches on a name, so an unrelated
//     `wrangler` belonging to someone else is untouched.
//   * **The child's exit status is this command's exit status.** A caller —
//     Playwright's `webServer` among them — needs to know the server died rather
//     than reporting success.
//   * **Signals are forwarded.** Ctrl-C reaches the Worker, which is what lets
//     workerd flush D1 writes instead of losing them.
//
// Log capture is unchanged in shape: wrangler's banners interleave with the JSON,
// so the stream is recorded as-is and the log reader skips non-JSON lines.

import { type ChildProcess, spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { killTree } from '@starter/utils/process';
import { EXIT, fail } from './shared/command.ts';
import { API_DIR, REPO_ROOT } from './shared/paths.ts';
import { missingToolMessage, wranglerBin } from './shared/tools.ts';

const WRANGLER = wranglerBin() ?? join(API_DIR, 'node_modules', '.bin', 'wrangler');

/** Inside the checkout, so a worktree's state is its own. Gitignored. */
const STATE_DIR = join(REPO_ROOT, '.wrangler', 'local');
const LOG_DIR = process.env.STARTER_LOG_DIR ?? join(REPO_ROOT, '.wrangler', 'logs');
const LOG_FILE = join(LOG_DIR, 'api.ndjson');
const PIDFILE = join(STATE_DIR, 'api-dev.pid');

const PORT = process.env.API_PORT ?? '8787';

/**
 * Stop the worker.
 *
 * `detached: false` is deliberate and load-bearing. With `detached: true` wrangler
 * gets its own process group, which survives when Playwright's `webServer` teardown
 * kills the group it spawned — the detached workerd kept holding port 8788 and the
 * *next* `bun run e2e` refused with "already used". Staying in the launcher's group
 * means whatever kills the launcher kills the server with it.
 *
 * The consequence is that the child is not a group leader, so `killTree` walks the
 * process tree rather than signalling a process group. Signalling the negative pid
 * would target the launcher's own group — which includes the shell that invoked
 * `bun run e2e`.
 */
const stopWorker = (child: ChildProcess): number[] => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [];
  }
  // No pid means the spawn failed, and there is no tree to take down. It must not
  // become a `0` for `killTree`: pid 0 means "every process in my group" to
  // `process.kill`, so a failed spawn would have signalled the launcher and
  // whatever else it owns.
  if (child.pid === undefined) {
    return [];
  }
  return killTree(child.pid, { graceMs: 300, attempts: 25 });
};

/** Stop whatever a previous run of this checkout left behind. */
const clearStale = (): void => {
  if (!existsSync(PIDFILE)) {
    return;
  }

  const previous = Number.parseInt(readFileSync(PIDFILE, 'utf8').trim(), 10);
  if (Number.isFinite(previous) && previous > 1) {
    killTree(previous, { graceMs: 100, attempts: 10 });
  }
  rmSync(PIDFILE, { force: true });
};

const buildArgs = (): string[] => {
  const args = ['dev', '--port', PORT, '--local', '--config', join(API_DIR, 'wrangler.jsonc')];

  // `--var NAME:value`, not an exported environment variable: `wrangler dev` only
  // passes a value through to the Worker when it is given as a var, and the Worker
  // reads its configuration from its bindings. An exported shell variable is
  // visible to the wrangler process and invisible to the code it serves.
  //
  // Two argv elements, not one `"--var NAME:value"` string. `spawn` does no word
  // splitting, so a combined element reaches wrangler's parser as an unknown flag
  // and it exits 1 with a usage dump naming every option it does accept.
  const varFlag = (name: string, value: string): string[] => ['--var', `${name}:${value}`];

  // DEPLOYMENT_ENV, BETTER_AUTH_URL and BETTER_AUTH_SECRET are always passed. The
  // Worker decides whether development defaults are permitted from DEPLOYMENT_ENV
  // alone and validates BETTER_AUTH_URL structurally in every environment, so a
  // local run missing any of the three fails closed with a 503 naming the binding.
  // That is intended; `bun run dev:api` still works on a fresh clone because these
  // three have local defaults here.
  args.push(...varFlag('DEPLOYMENT_ENV', process.env.DEPLOYMENT_ENV ?? 'local'));
  args.push(
    ...varFlag('BETTER_AUTH_URL', process.env.BETTER_AUTH_URL ?? `http://127.0.0.1:${PORT}`),
  );
  args.push(
    ...varFlag(
      'BETTER_AUTH_SECRET',
      process.env.BETTER_AUTH_SECRET ?? 'local-dev-secret-not-for-production',
    ),
  );

  // Only when set, so an ordinary `bun run dev:api` does not carry a stale run id
  // or a test-only rate limit from a previous run.
  for (const name of ['TEST_RUN_ID', 'AUTH_RATE_LIMIT_MAX', 'TRUSTED_ORIGINS']) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) {
      args.push(...varFlag(name, value));
      process.stdout.write(`${name}: ${value}\n`);
    }
  }

  return args;
};

/**
 * Start the Worker and resolve when it stops.
 *
 * Returns an exit code rather than setting `process.exitCode` directly, because
 * the dispatcher owns the process's exit and this module is also reachable from a
 * test that starts it as a child.
 *
 * The promise resolves on the first of: the child exiting, or a signal arriving.
 * A signal path resolves after the tree has been torn down, so a caller that
 * `await`s this knows nothing of the Worker's is left running.
 */
export const main = (): Promise<number> => {
  if (!existsSync(WRANGLER)) {
    return Promise.resolve(
      fail(missingToolMessage('wrangler', 'apps/backend/api'), EXIT.unavailable),
    );
  }

  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(dirname(PIDFILE), { recursive: true });
  clearStale();

  // Truncate rather than append: a run that appends to the previous run's log
  // makes `bun run logs --mode local` report events from a process that is gone.
  writeFileSync(LOG_FILE, '');

  const log = createWriteStream(LOG_FILE, { flags: 'a' });

  process.stdout.write(`API log -> ${LOG_FILE}\n  bun run logs api --mode local --follow\n\n`);

  // `detached: false` — see `stopWorker`. Staying in the launcher's own process
  // group is what lets Playwright's `webServer` teardown reach the server.
  const child: ChildProcess = spawn(WRANGLER, buildArgs(), {
    cwd: REPO_ROOT,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const childPid = child.pid ?? 0;
  writeFileSync(PIDFILE, String(childPid));

  child.stdout?.on('data', (chunk: Buffer) => {
    log.write(chunk);
    process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    log.write(chunk);
    process.stderr.write(chunk);
  });

  return new Promise<number>((resolve) => {
    // Whether the caller asked us to stop, as opposed to the Worker dying. Only
    // the latter should be reported as a failure.
    let stopped = false;
    let settled = false;

    // One-time listeners, and removed at teardown.
    //
    // `process.on` registers on the *process*, not on this promise, so a `main()`
    // that resolves leaves its handlers behind: a second SIGTERM would re-enter
    // `shutdown`, and the listeners keep the process alive for whoever embedded it.
    // `once` also restores default signal handling after the first delivery, so a
    // second Ctrl-C is a normal kill.
    const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const onSignal = (signal: NodeJS.Signals): void => {
      shutdown(signal);
    };
    // The path that delivers no signal: an uncaught throw, or a caller that simply
    // exits. Synchronous because `exit` handlers may not await.
    const onExit = (): void => {
      teardown();
    };

    /** Remove everything this run added to the process. */
    const unregister = (): void => {
      for (const signal of SIGNALS) {
        process.removeListener(signal, onSignal);
      }
      process.removeListener('exit', onExit);
    };

    for (const signal of SIGNALS) {
      // `{ once: true }`: a second SIGTERM is a normal kill rather than a second
      // teardown against a child that is already gone.
      process.once(signal, onSignal);
    }
    process.on('exit', onExit);

    const teardown = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      // Before the kill, not after: `killTree` is synchronous and blocking, and a
      // signal arriving during it would find the handlers still registered.
      unregister();
      stopWorker(child);
      rmSync(PIDFILE, { force: true });
      log.end();
    };

    const shutdown = (signal: NodeJS.Signals): void => {
      if (settled) {
        return;
      }
      stopped = true;
      process.stderr.write(`\nStopping the API (${signal}).\n`);

      const survivors = stopWorker(child);
      if (survivors.length > 0) {
        // Named, not swallowed. A pid that survived teardown will hold the port
        // and break the next run, so it has to be visible.
        process.stderr.write(
          `These pids survived teardown and may still hold ${PORT}: ${survivors.join(', ')}\n`,
        );
      }

      teardown();
      resolve(survivors.length === 0 ? EXIT.ok : EXIT.failed);
    };

    child.on('error', (error) => {
      process.stderr.write(`could not start wrangler: ${error.message}\n`);
      teardown();
      resolve(EXIT.unavailable);
    });

    child.on('exit', (code, signal) => {
      const exitedCleanly = !stopped;
      if (exitedCleanly) {
        process.stderr.write(`\nThe API exited (${signal ?? `code ${code ?? 'unknown'}`}).\n`);
      }
      teardown();

      // Preserved, not flattened to 0. A caller — Playwright's `webServer` among
      // them — needs to know the server died rather than reporting success.
      //
      // A signalled child has no exit code of its own, so it reports failure with
      // the signal named above. Mapping it to the shell's 128+N would invent a
      // number the caller cannot act on, and would collide with a real code.
      resolve(code ?? EXIT.failed);
    });
  });
};
