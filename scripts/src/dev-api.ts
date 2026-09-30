// scripts/dev/api.ts
//
//   bun run dev:api
//
// Run the Worker locally and capture its log stream to a file.
//
// Replaces the shell launcher this used to be. The shell version spawned wrangler
// with `setsid` and could not reliably clean it up: Playwright starts this through
// `webServer`, tears it down when the run ends, and the detached `workerd` survived
// holding port 8788. The *next* `bun run e2e` then refused with "already used" —
// a dev command that breaks the command after it.
//
// Two things are owned here that a shell script could not do well:
//
//   1. **Process-group ownership.** wrangler runs `detached`, so it gets its own
//      process group, and it is killed as a *group*. Signalling wrangler alone
//      leaves workerd — its child — holding the port, which is the actual failure
//      that was observed.
//   2. **Per-checkout state.** The PID file lives in this checkout's
//      `.wrangler/local`, not a shared `/tmp` path, so two worktrees on one machine
//      do not kill each other's server.
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
import { fileURLToPath } from 'node:url';
import { killTree } from '@starter/utils/process';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const API_DIR = join(REPO_ROOT, 'apps/backend/api');
const WRANGLER = join(API_DIR, 'node_modules', '.bin', 'wrangler');

const LOG_DIR = process.env.STARTER_LOG_DIR ?? '/tmp/starter-logs';
const LOG_FILE = join(LOG_DIR, 'api.ndjson');
const STATE_DIR = process.env.STARTER_STATE_DIR ?? join(REPO_ROOT, '.wrangler', 'local');
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
  return killTree(child.pid ?? 0, { graceMs: 300, attempts: 25 });
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

export const main = (): void => {
  if (!existsSync(WRANGLER)) {
    process.stderr.write(
      `wrangler is not installed at ${WRANGLER}.\n` +
        'It is a pinned dependency of apps/backend/api. Run `bun install` from the repository root.\n',
    );
    process.exitCode = 1;
    return;
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

  let stopped = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    process.stderr.write(`\nStopping the API (${signal}).\n`);

    const survivors = stopWorker(child);
    if (survivors.length > 0) {
      // Named, not swallowed. A pid that survived teardown will hold the port and
      // break the next run, so it has to be visible.
      process.stderr.write(
        `These pids survived teardown and may still hold ${PORT}: ${survivors.join(', ')}\n`,
      );
    }

    rmSync(PIDFILE, { force: true });
    log.end();
    process.exit(survivors.length === 0 ? 0 : 1);
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => shutdown(signal));
  }

  // Covers the paths that do not deliver a signal — an uncaught throw, or a caller
  // that simply exits.
  process.on('exit', () => {
    if (stopped) {
      return;
    }
    stopped = true;
    stopWorker(child);
    rmSync(PIDFILE, { force: true });
  });

  child.on('error', (error) => {
    process.stderr.write(`could not start wrangler: ${error.message}\n`);
    rmSync(PIDFILE, { force: true });
    process.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    rmSync(PIDFILE, { force: true });
    log.end();
    if (!stopped) {
      process.stderr.write(`\nThe API exited (${signal ?? `code ${code ?? 'unknown'}`}).\n`);
    }
    // Preserved, not flattened to 0. A caller — Playwright's `webServer` among
    // them — needs to know the server died rather than reporting success.
    process.exitCode = code ?? 1;
  });
};

if (import.meta.main) {
  main();
}
