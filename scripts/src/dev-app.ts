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
// origin, and the adapter emulates the Worker's bindings from
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
//     workerd finish its request lifecycle instead of losing pending writes.
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
import { killTree } from '@starter/utils/process';
import {
  allocateSupabaseLocal,
  hasSupabaseOwnership,
  readSupabaseOwnership,
  removeOwnedWorkerVars,
  startSupabaseLocal,
  stopSupabaseLocal,
  writeOwnedWorkerVars,
} from './db/supabase_local.ts';
import { EXIT, fail } from './shared/command.ts';
import { CLIENT_DIR, REPO_ROOT } from './shared/paths.ts';
import { runScope, worktreePort } from './shared/run_scope.ts';
import { viteBin, wranglerBin } from './shared/tools.ts';

/**
 * The compiled Worker. This is the artifact a deploy ships, so `built` mode serves
 * exactly this file and not a directory.
 */
const BUILT_WORKER = join(CLIENT_DIR, '.svelte-kit/cloudflare/_worker.js');
const WRANGLER_CONFIG = join(CLIENT_DIR, 'wrangler.jsonc');

/** E2E gets a fresh Wrangler store and process record for each invocation. */
const E2E_SCOPE = process.env.E2E_RUN_ID ? runScope(process.env.E2E_RUN_ID) : undefined;

/** Ordinary local development keeps its stable store; E2E never touches it. */
const STATE_DIR = E2E_SCOPE?.stateDir ?? join(REPO_ROOT, '.wrangler', 'local');
const LOG_DIR =
  process.env.STARTER_LOG_DIR ?? E2E_SCOPE?.logDir ?? join(REPO_ROOT, '.wrangler', 'logs');
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
const PORT = process.env.PORT ?? String(worktreePort(5200, REPO_ROOT));
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
// Credentials belong in the run-owned environment file, never command arguments.
const FORWARDED_VARS = [
  'TEST_RUN_ID',
  'DEPLOYMENT_ENV',
  'SUPABASE_MAIL_URL',
  'APP_ORIGIN',
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
 * `APP_ORIGIN` is handled separately and deliberately, because nothing else
 * can supply it correctly.
 *
 * The launcher passes `--host`, which makes Wrangler 4.142.0 rewrite the request
 * URL, Host and Origin to omit the public port. Without that flag the port is
 * preserved. `requestOriginFor` cannot recover a port absent from both URL and
 * Host, so this launcher supplies the public origin through `APP_ORIGIN`.
 *
 * A caller that already set `APP_ORIGIN` keeps their value: this is a default,
 * not an override.
 */
const varFlags = (): string[] => {
  const args: string[] = [];

  for (const name of FORWARDED_VARS) {
    let value = process.env[name];
    if (name === 'APP_ORIGIN') {
      value = value || `http://${HOST}:${PORT}`;
    } else if (name === 'TEST_RUN_ID') {
      value = process.env.TEST_RUN_ID ?? E2E_SCOPE?.runId;
    }
    if (value !== undefined && value.length > 0) {
      args.push('--var', `${name}:${value}`);
    }
  }

  const configuredUrl = process.env.APP_ORIGIN;
  const resolvedUrl =
    configuredUrl !== undefined && configuredUrl.length > 0
      ? configuredUrl
      : `http://${HOST}:${PORT}`;
  args.push('--var', `APP_ORIGIN:${resolvedUrl}`);

  return args;
};

const persistenceFlags = (): string[] =>
  E2E_SCOPE === undefined ? [] : ['--persist-to', E2E_SCOPE.stateDir];

const localEnvFileFlags = (varsPath = process.env.STARTER_DEV_VARS_PATH): string[] =>
  varsPath === undefined ? [] : ['--env-file', varsPath];

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
export const buildTarget = (mode: DevMode, varsPath?: string): Target => {
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
        ...persistenceFlags(),
        ...localEnvFileFlags(varsPath),
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
/**
 * The backend `bun run dev` will talk to.
 *
 * Supabase is the only backend, so a dev server with no `SUPABASE_URL` has nothing
 * to talk to and every request is a 503 that names three variables. That was the
 * state of this command after the cutover: the Worker, database and E2E lanes each
 * provision an owned local stack, and `dev` was the one lane that provisioned
 * nothing. It now starts the same stack, but only when the caller has not named a
 * project — setting `SUPABASE_URL` yourself keeps dev pointed where you asked.
 *
 * Both dev modes read this file. `wrangler dev` takes it as `--env-file`; the Vite
 * server's platform proxy takes it as `STARTER_RUNTIME_ENV_FILE`, which is why the
 * values live in a file rather than in the spawned environment: the service-role
 * key is a local stack credential and never belongs in argv or in a child's env.
 */
export interface DevBackend {
  /** The owned env file both modes read. */
  varsPath: string;
  /** True when this run started the stack and must stop it. */
  owned: boolean;
  /** One line for the developer, naming what was started. */
  summary: string[];
  /** Stops the stack and removes the file; failures are reported, not thrown. */
  dispose: () => Promise<string[]>;
}

/**
 * The collaborators `prepareDevBackend` uses.
 *
 * Injectable so the decision — provision or trust the caller's project — is testable
 * without a container engine. Defaults are the real ones; a test that swaps them is
 * testing this function's logic rather than Docker's availability.
 */
export interface DevBackendDependencies {
  allocate: typeof allocateSupabaseLocal;
  start: typeof startSupabaseLocal;
  writeVars: typeof writeOwnedWorkerVars;
  hasOwnership: typeof hasSupabaseOwnership;
  readOwnership: typeof readSupabaseOwnership;
  stop: typeof stopSupabaseLocal;
}

const devBackendDependencies: DevBackendDependencies = {
  allocate: allocateSupabaseLocal,
  start: startSupabaseLocal,
  writeVars: writeOwnedWorkerVars,
  hasOwnership: hasSupabaseOwnership,
  readOwnership: readSupabaseOwnership,
  stop: stopSupabaseLocal,
};

/** The Supabase values a caller has already placed in the environment, if any. */
export const callerSupabaseValues = (
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
  const present = names.filter((name) => (environment[name] ?? '').trim().length > 0);
  return Object.fromEntries(present.map((name) => [name, environment[name] as string]));
};

export const prepareDevBackend = async (
  origin: string,
  overrides: Partial<DevBackendDependencies> = {},
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DevBackend> => {
  const dependencies = { ...devBackendDependencies, ...overrides };
  const inherited = callerSupabaseValues(environment);
  const shouldProvision = inherited.SUPABASE_URL === undefined;

  const allocation = dependencies.allocate(
    REPO_ROOT,
    `dev_${process.pid}_${crypto.randomUUID().slice(0, 8)}`,
  );
  const summary: string[] = [];
  let values: Record<string, string> = { ...inherited };
  let mailUrl = environment.SUPABASE_MAIL_URL;
  let owned = false;

  if (shouldProvision) {
    // Email confirmations off: a developer's own loop should reach the app after
    // sign-up. The verified-email flow is covered by the E2E lane, which turns
    // confirmations on because it redeems real links.
    const started = await dependencies.start(allocation, { emailConfirmations: false });
    owned = true;
    values = { ...started };
    mailUrl = started.SUPABASE_MAIL_URL;
    summary.push(
      `Local Supabase (started by this run) -> ${started.SUPABASE_URL}`,
      `  Studio -> ${allocation.urls.studio}`,
    );
  } else {
    summary.push(`Supabase project -> ${inherited.SUPABASE_URL ?? ''}`);
  }

  // Both modes read this file: wrangler as `--env-file`, the Vite platform proxy
  // through STARTER_RUNTIME_ENV_FILE. `DEPLOYMENT_ENV` and `APP_ORIGIN` are here
  // because the dev server previously forwarded neither.
  const vars = await dependencies.writeVars(allocation, {
    ...values,
    DEPLOYMENT_ENV: 'local',
    APP_ORIGIN: origin,
    ...(mailUrl === undefined ? {} : { SUPABASE_MAIL_URL: mailUrl }),
  });

  return {
    varsPath: vars.path,
    owned,
    summary,
    dispose: async () => {
      // Independent steps: a failure removing the file must not skip stopping the
      // stack, which would leave containers and ports bound after the dev server
      // is gone. The first failure is reported; the child's exit status still wins.
      const failures: string[] = [];
      try {
        await removeOwnedWorkerVars(vars.path, vars.contents);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
      if (owned) {
        try {
          if (await dependencies.hasOwnership(allocation)) {
            await dependencies.stop(allocation, await dependencies.readOwnership(allocation));
          }
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      return failures;
    },
  };
};

export const main = async (mode: DevMode = 'app'): Promise<number> => {
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

  // One resolution of the public origin, used by the env file, the forwarded vars
  // and the banner. A caller that already set APP_ORIGIN keeps their value.
  const origin = process.env.APP_ORIGIN ?? `http://${HOST}:${PORT}`;
  process.env.APP_ORIGIN = origin;

  let backend: DevBackend | undefined;
  try {
    backend = await prepareDevBackend(origin);
  } catch (error) {
    return fail(
      `The dev backend could not start: ${error instanceof Error ? error.message : String(error)}\n` +
        '  Local Supabase needs Docker or Podman. Run `bun run setup:doctor -- --profile database`,\n' +
        '  or set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY to use a project instead.',
      EXIT.unavailable,
    );
  }

  // The child reads the owned file: wrangler through `--env-file`, the Vite
  // platform proxy through this variable. One file, both modes.
  process.env.STARTER_DEV_VARS_PATH = backend.varsPath;
  process.env.STARTER_RUNTIME_ENV_FILE = backend.varsPath;
  const server = buildTarget(mode, backend.varsPath);

  // Truncate rather than append: a run that appends to the previous run's log
  // makes `bun run logs web --mode local` report events from a process that is gone.
  writeFileSync(LOG_FILE, '');

  const log = createWriteStream(LOG_FILE, { flags: 'a' });

  process.stdout.write(
    `${server.label} -> ${origin}\n` +
      `${backend.summary.join('\n')}\n` +
      `App log -> ${LOG_FILE}\n` +
      '  bun run logs web --mode local --follow\n\n',
  );

  // `detached: false` — see `stopServer`. Staying in the launcher's own process
  // group is what lets Playwright's `webServer` teardown reach the server.
  const child: ChildProcess = spawn(server.bin as string, server.args, {
    cwd: server.cwd,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
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

  const exitCode = await new Promise<number>((resolve) => {
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

  // After the server is gone, not before: the stack is its database, and stopping
  // it while requests are in flight would fail them. A teardown failure is
  // reported and turns a clean stop into a failed one, but it never replaces the
  // child's own exit status.
  const teardownFailures = await backend.dispose();
  if (teardownFailures.length > 0) {
    for (const failure of teardownFailures) {
      process.stderr.write(`Dev backend teardown failed: ${failure}\n`);
    }
    return exitCode === EXIT.ok ? EXIT.failed : exitCode;
  }
  return exitCode;
};
