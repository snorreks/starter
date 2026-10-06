// scripts/src/dev-app.ts
//
//   bun run dev            # the Vite dev server, Node, emulated bindings
//   bun run dev built      # the built Worker in workerd, real bindings
//
// Start the application locally, and capture its log stream to a file.
//
// One process, because there is one application. This used to be `dev-api.ts`,
// which ran `wrangler dev` for a separate API Worker while a Vite dev server
// served the pages and proxied `/api` to it. Both halves are now one SvelteKit
// server: `vite dev` serves the pages, the assets and `/api/*` from a single
// origin, and the adapter emulates the Worker's bindings (D1 included) from
// `apps/frontend/client/wrangler.jsonc`.
//
// **Why there are still two modes.** The dev server runs the server code in Node,
// where the platform does not exist: `cloudflare:workers` is a stub, workerd is not
// involved, and an import that resolves here can fail in the real runtime. The
// `built` mode serves the compiled `.svelte-kit/cloudflare/_worker.js` through
// `wrangler dev`, which *is* workerd, and is therefore what the E2E lane and any
// check of the shipped artifact use. One mode would have to be wrong about
// something, and the honest answer is that the fast one cannot see bundling
// mistakes — so the slower one exists and is used where correctness is the point.
//
// Ownership, which is the part a shell script got wrong:
//
//   * **Per-checkout, not per-machine.** State lives in this checkout's
//     `.wrangler/`, never in a shared `/tmp` path. Two worktrees on one machine
//     each run their own server; the old script's `/tmp/starter-wrangler.pid`
//     meant the second worktree killed the first one's server.
//   * **Owned, not pattern-killed.** Only the process this run started, and its
//     descendants, are ever signalled. Nothing matches on a name, so an unrelated
//     `vite` belonging to someone else is untouched.
//   * **The child's exit status is this command's exit status.** A caller —
//     Playwright's `webServer` among them — needs to know the server died rather
//     than reporting success.
//   * **Signals are forwarded.** Ctrl-C reaches the child, which is what lets
//     workerd flush D1 writes instead of losing them.
//
// Log capture is unchanged in shape: the child's output interleaves banners with
// the log stream, so it is recorded as-is and the log reader skips non-JSON lines.
// The file is `.wrangler/logs/app.ndjson`, and `bun run logs web --mode local`
// reads it. Under Node there is no platform console capture, which is why the
// server writes NDJSON itself — see
// `apps/frontend/client/src/lib/server/request_context.ts`. Under workerd the
// platform captures console output and wrangler prints it as JSON, so the same
// reader works there unchanged.

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
import { MOCK_USER } from '@starter/fixtures';
import { killTree } from '@starter/utils/process';
import { runWrangler } from './cloudflare/wrangler.ts';
import { SEED_STATEMENTS } from './db/seed.ts';
import { EXIT, fail } from './shared/command.ts';
import { CLIENT_DIR, REPO_ROOT } from './shared/paths.ts';
import { viteBin, wranglerBin } from './shared/tools.ts';

/**
 * The compiled Worker. This is the artifact a deploy ships, so `built` mode serves
 * exactly this file and not a directory.
 */
const BUILT_WORKER = join(CLIENT_DIR, '.svelte-kit/cloudflare/_worker.js');
const WRANGLER_CONFIG = join(CLIENT_DIR, 'wrangler.jsonc');

/** Inside the checkout, so a worktree's state is its own. Gitignored. */
const STATE_DIR = join(REPO_ROOT, '.wrangler', 'local');
const LOG_DIR = process.env.STARTER_LOG_DIR ?? join(REPO_ROOT, '.wrangler', 'logs');
const LOG_FILE = join(LOG_DIR, 'app.ndjson');
const PIDFILE = join(STATE_DIR, 'dev.pid');

/**
 * The port and host.
 *
 * Read from the same environment variables `apps/frontend/client/dev_ports.ts`
 * reads, rather than parsed again here. Two readers of two sources is how a dev
 * server and the documented URL come to disagree — which is the bug that module
 * exists to prevent — so there is one place that decides.
 */
const PORT = process.env.PORT ?? '5173';
const HOST = process.env.DEV_HOST ?? '127.0.0.1';

/**
 * Worker vars this launcher forwards to the runtime.
 *
 * `--var NAME:value`, not an exported environment variable: `wrangler dev` only
 * passes a value through to the Worker when it is given as a var, and the Worker
 * reads its configuration from its bindings. An exported shell variable is visible
 * to the wrangler process and invisible to the code it serves.
 *
 * Two argv elements per var, not one `"--var NAME:value"` string. `spawn` does no
 * word splitting, so a combined element reaches wrangler's parser as an unknown
 * flag and it exits 1 with a usage dump naming every option it does accept.
 *
 * Only when set, so an ordinary `bun run dev` carries nothing and cannot inherit a
 * stale run id or a test-only rate limit from a previous run.
 */
const FORWARDED_VARS = [
  'TEST_RUN_ID',
  'AUTH_RATE_LIMIT_MAX',
  'TRUSTED_ORIGINS',
  'BETTER_AUTH_SECRET',
  'DEPLOYMENT_ENV',
] as const;

/**
 * Stop the server.
 *
 * `detached: false` is deliberate and load-bearing. With `detached: true` the child
 * gets its own process group, which survives when Playwright's `webServer`
 * teardown kills the group it spawned — the detached server kept holding its port
 * and the *next* `bun run e2e` refused with "already used". Staying in the
 * launcher's group means whatever kills the launcher kills the server with it.
 *
 * The consequence is that the child is not a group leader, so `killTree` walks the
 * process tree rather than signalling a process group. Signalling the negative pid
 * would target the launcher's own group — which includes the shell that invoked
 * `bun run e2e`.
 */
const stopServer = (child: ChildProcess): number[] => {
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

/**
 * Bindings to forward, with the local origin resolved by this launcher.
 *
 * `BETTER_AUTH_URL` is handled separately and deliberately, because nothing else
 * can supply it correctly.
 *
 * The launcher passes `--host`, which makes Wrangler 4.142.0 rewrite the request
 * URL, Host and Origin to omit the public port. Without that flag the port is
 * preserved. `requestOriginFor` cannot recover a port absent from both URL and
 * Host, so this launcher supplies the public origin through `BETTER_AUTH_URL`.
 *
 * A caller that already set `BETTER_AUTH_URL` keeps their value: this is a default,
 * not an override.
 */
const varFlags = (): string[] => {
  const args: string[] = [];

  for (const name of FORWARDED_VARS) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) {
      args.push('--var', `${name}:${value}`);
    }
  }

  const configuredUrl = process.env.BETTER_AUTH_URL;
  const resolvedUrl =
    configuredUrl !== undefined && configuredUrl.length > 0
      ? configuredUrl
      : `http://${HOST}:${PORT}`;
  args.push('--var', `BETTER_AUTH_URL:${resolvedUrl}`);

  return args;
};

/**
 * The launcher surface these tests read.
 *
 * Declared here rather than re-invented at each call site: a test that re-declares
 * the shape it expects is testing its own annotation, not the module.
 */
export interface Target {
  bin: string | null;
  declaringPackage: string;
  args: string[];
  cwd: string;
  label: string;
}

/**
 * The two ways to run the application locally, as the CLI words them.
 *
 * `app` is the Vite dev server, which runs the server code in Node against
 * emulated bindings. `built` serves the compiled Worker through `wrangler dev`,
 * which is workerd. The names are the CLI's words rather than an internal vocabulary
 * because the only thing that selects between them is `bun run dev app|built`, and
 * two names for one switch is a name that eventually disagrees with the other.
 */
export type DevMode = 'app' | 'built';

/**
 * The command that serves the app, for a given mode.
 *
 * Split from `main` so the argv can be asserted without spawning anything — a
 * launcher whose flags are only observable by running it is a launcher nobody can
 * test. Exported for that reason.
 */
export const buildTarget = (mode: DevMode): Target => {
  if (mode === 'built') {
    return {
      bin: wranglerBin(),
      declaringPackage: 'apps/frontend/client',
      args: [
        'dev',
        BUILT_WORKER,
        '--port',
        PORT,
        '--host',
        HOST,
        '--config',
        WRANGLER_CONFIG,
        ...varFlags(),
      ],
      cwd: CLIENT_DIR,
      label: 'Built Worker (workerd)',
    };
  }

  return {
    bin: viteBin(),
    declaringPackage: 'apps/frontend/client',
    args: ['dev', '--port', PORT, '--strictPort', '--host', HOST],
    cwd: CLIENT_DIR,
    label: 'Dev server (Node)',
  };
};

/**
 * Start the application and resolve when it stops.
 *
 * Returns an exit code rather than setting `process.exitCode` directly, because the
 * dispatcher owns the process's exit and this module is also reachable from a
 * test that starts it as a child.
 *
 * The promise resolves on the first of: the child exiting, or a signal arriving.
 * A signal path resolves after the tree has been torn down, so a caller that
 * `await`s this knows nothing of the server's is left running.
 */
export const main = (mode: DevMode = 'app'): Promise<number> => {
  if (mode === 'app') {
    const configArgs = ['--config', WRANGLER_CONFIG];
    const migrated = runWrangler(['d1', 'migrations', 'apply', 'DB', '--local', ...configArgs]);
    if (migrated !== 0) {
      return Promise.resolve(
        fail('Could not prepare the emulator database (local D1 migrations failed).'),
      );
    }
    const seeded = runWrangler([
      'd1',
      'execute',
      'DB',
      '--local',
      ...configArgs,
      '--command',
      SEED_STATEMENTS.join('; '),
    ]);
    if (seeded !== 0) {
      return Promise.resolve(
        fail('Could not populate the emulator database (local D1 seed failed).'),
      );
    }
  }

  const target = buildTarget(mode);

  if (target.bin === null) {
    return Promise.resolve(
      fail(
        `The tool serving this mode is not installed. It is a pinned workspace ` +
          `dependency of ${target.declaringPackage}. Run \`bun install\` from the ` +
          'repository root.',
        EXIT.unavailable,
      ),
    );
  }

  if (mode === 'built' && !existsSync(BUILT_WORKER)) {
    // Refused rather than serving nothing. `wrangler dev` on a missing entrypoint
    // either fails with a message about the file or starts a server that answers
    // 404 to everything, and the second looks like a broken application.
    return Promise.resolve(
      fail(
        `Missing ${BUILT_WORKER}.\n` +
          '  Run `bun run build` first: this mode serves the compiled Worker, because ' +
          'the dev server runs in Node where a bundling mistake cannot appear.',
        EXIT.failed,
      ),
    );
  }

  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(dirname(PIDFILE), { recursive: true });
  clearStale();

  // Truncate rather than append: a run that appends to the previous run's log
  // makes `bun run logs web --mode local` report events from a process that is gone.
  writeFileSync(LOG_FILE, '');

  const log = createWriteStream(LOG_FILE, { flags: 'a' });

  process.stdout.write(
    `${target.label} -> http://${HOST}:${PORT}\n` +
      `App log -> ${LOG_FILE}\n` +
      '  bun run logs web --mode local --follow\n\n',
  );

  // `detached: false` — see `stopServer`. Staying in the launcher's own process
  // group is what lets Playwright's `webServer` teardown reach the server.
  const child: ChildProcess = spawn(target.bin, target.args, {
    cwd: target.cwd,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(mode === 'app'
        ? {
            STARTER_EMULATOR_MOCKS: 'true',
            STARTER_EMULATOR_USER_ID: MOCK_USER.id,
          }
        : {}),
    },
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
    // Whether the caller asked us to stop, as opposed to the server dying. Only
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
      stopServer(child);
      rmSync(PIDFILE, { force: true });
      log.end();
    };

    const shutdown = (signal: NodeJS.Signals): void => {
      if (settled) {
        return;
      }
      stopped = true;
      process.stderr.write(`\nStopping the dev server (${signal}).\n`);

      const survivors = stopServer(child);
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
      process.stderr.write(`could not start the dev server: ${error.message}\n`);
      teardown();
      resolve(EXIT.unavailable);
    });

    child.on('exit', (code, signal) => {
      const exitedCleanly = !stopped;
      if (exitedCleanly) {
        process.stderr.write(
          `\nThe dev server exited (${signal ?? `code ${code ?? 'unknown'}`}).\n`,
        );
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
