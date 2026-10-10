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
import { parseEnv } from 'node:util';
import { killTree } from '@starter/utils/process';
import { seedSupabaseLocal } from './db/seed_supabase.ts';
import {
  allocateSupabaseLocal,
  hasSupabaseOwnership,
  readSupabaseOwnership,
  removeOwnedWorkerVars,
  startSupabaseLocal,
  stopSupabaseLocal,
  writeOwnedWorkerVars,
} from './db/supabase_local.ts';
import { startStack } from './dev-stack.ts';
import { prepareContainerService } from './local/container_service.ts';
import { prepareJobsService } from './local/jobs_service.ts';
import {
  disposeServices,
  type LocalService,
  type LocalServiceContext,
  type LocalServiceId,
  LocalServiceUnavailable,
  mergeServiceVars,
} from './local/service.ts';
import { prepareStripeService } from './local/stripe_service.ts';
import {
  callerSupabaseValues,
  devAutoSignInOffered,
  prepareSupabaseService,
} from './local/supabase_service.ts';
import { removeOwnedVars, writeOwnedVars } from './local/vars_file.ts';
import { EXIT, fail } from './shared/command.ts';
import { CLIENT_DIR, REPO_ROOT } from './shared/paths.ts';
import { runScope, worktreePort } from './shared/run_scope.ts';
import { viteBin, wranglerBin } from './shared/tools.ts';

// Re-exported from the service module that owns them, because these two names are
// part of this file's published surface: `apps/e2e/scripts/run_e2e.ts`,
// `apps/frontend/client/scripts/run_integration.ts` and `scripts/tests` import them
// from here. Re-exporting rather than re-declaring keeps one implementation and one
// set of tests for a rule the harnesses all depend on.
export { callerSupabaseValues, devAutoSignInOffered };

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
 * The run id every local service in this launch shares.
 *
 * One id, not one per service: it is what ties a container name, a state directory
 * and a teardown to the same invocation. A service that minted its own would leave
 * resources this launcher cannot find to clean up, which is how a `docker ps`
 * full of `starter-stripe-mock-*` accumulates.
 */
const DEV_STACK_RUN_ID = `dev_stack_${process.pid}`;

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
  /**
   * The owned env file both modes read, or `undefined` when this run wrote none.
   *
   * Undefined means the caller's own file is in charge and must not be replaced:
   * the E2E lane keeps the service-role key out of the environment and in the file
   * it owns, so overwriting it with one built from the environment alone drops a
   * credential the lane depends on.
   */
  varsPath: string | undefined;
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
 *
 * Eight fields rather than the six `SupabaseServiceDependencies` carries, because
 * this is the wrapper's seam and it owns two things the service does not: writing
 * the owned vars file, and reading the caller's file to decide whether the backend
 * is already complete. The six are forwarded to the service unchanged, so there is
 * one allocate/start/seed implementation behind both entry points.
 */
export interface DevBackendDependencies {
  allocate: typeof allocateSupabaseLocal;
  start: typeof startSupabaseLocal;
  seed: typeof seedSupabaseLocal;
  writeVars: typeof writeOwnedWorkerVars;
  /** Values may be absent: a dotenv file need not carry every binding. */
  readVars: (path: string) => Record<string, string | undefined>;
  hasOwnership: typeof hasSupabaseOwnership;
  readOwnership: typeof readSupabaseOwnership;
  stop: typeof stopSupabaseLocal;
}

const devBackendDependencies: DevBackendDependencies = {
  allocate: allocateSupabaseLocal,
  start: startSupabaseLocal,
  seed: seedSupabaseLocal,
  writeVars: writeOwnedWorkerVars,
  readVars: (path: string): Record<string, string | undefined> =>
    parseEnv(readFileSync(path, 'utf8')),
  hasOwnership: hasSupabaseOwnership,
  readOwnership: readSupabaseOwnership,
  stop: stopSupabaseLocal,
};

export const prepareDevBackend = async (
  origin: string,
  overrides: Partial<DevBackendDependencies> = {},
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DevBackend> => {
  const dependencies = { ...devBackendDependencies, ...overrides };

  // The backend may already be complete across two places: the environment, and the
  // owned vars file a caller set. The E2E lane uses both — it passes the URL and
  // anon key in the environment and keeps the service-role key in the file — so
  // deciding on the environment alone would call a working configuration missing.
  const callerVarsPath = environment.STARTER_DEV_VARS_PATH;
  const callerFile: Record<string, string | undefined> =
    callerVarsPath === undefined ? {} : dependencies.readVars(callerVarsPath);

  const service = await prepareSupabaseService({
    origin,
    callerVars: callerFile,
    autoSignIn: devAutoSignInOffered(environment),
    environment,
    dependencies: {
      allocate: dependencies.allocate,
      start: dependencies.start,
      seed: dependencies.seed,
      hasOwnership: dependencies.hasOwnership,
      readOwnership: dependencies.readOwnership,
      stop: dependencies.stop,
    },
  });

  // The caller already had a complete backend. Their own file stays in charge and
  // this run writes nothing and owns nothing to tear down.
  if (service.allocation === undefined) {
    return {
      varsPath: callerVarsPath,
      owned: false,
      summary: [...service.summary],
      dispose: async () => [],
    };
  }

  // Both dev modes read this file: wrangler as `--env-file`, the Vite platform proxy
  // through STARTER_RUNTIME_ENV_FILE. `DEPLOYMENT_ENV` and `APP_ORIGIN` are added
  // here rather than by the service because they describe the *application*, not
  // the database — a second service must be able to set `DEPLOYMENT_ENV` without
  // this merge being where the collision is discovered.
  const vars = await dependencies.writeVars(service.allocation, {
    ...service.vars,
    DEPLOYMENT_ENV: 'local',
    APP_ORIGIN: origin,
  });

  return {
    varsPath: vars.path,
    owned: service.owned,
    summary: [...service.summary],
    dispose: async () => {
      // Independent steps, and both attempted. A failure removing the file must not
      // skip stopping the stack, which would leave containers and ports bound after
      // the dev server is gone; a failure stopping the stack must not skip removing
      // the credentials. The first failure is reported; the child's exit status still
      // wins.
      const failures: string[] = [];
      try {
        await removeOwnedWorkerVars(vars.path, vars.contents);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
      failures.push(...(await service.dispose()));
      return failures;
    },
  };
};

/**
 * Point the child at the owned vars file, in both modes' dialects.
 *
 * Exported for its test: this guard is what the E2E lane's credential depends on,
 * and a guard that can only be observed by running the whole lane is a guard
 * nobody changes safely.
 */
export const applyBackendVarsPath = (
  varsPath: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): void => {
  // Only when this run wrote one. A caller that owns a file keeps it: replacing it
  // with one built from the environment alone drops bindings we cannot see.
  if (varsPath === undefined) {
    return;
  }
  environment.STARTER_DEV_VARS_PATH = varsPath;
  environment.STARTER_RUNTIME_ENV_FILE = varsPath;
};

/**
 * Start the services a stack names, and resolve the run-owned vars file they
 * produced.
 *
 * Split from `main` so the stack composition is reachable without spawning a
 * server, and so a test can assert which services ran in which order.
 */
/**
 * The collaborators `prepareDevStack` uses.
 *
 * Injectable for the same reason `DevBackendDependencies` is: the decision this
 * function makes — read the caller's two sources and decide whether a stack is
 * needed — must be reachable from a test without a container engine. The default
 * `createService` starts real services; a test that swaps it is testing this
 * function's merge rather than Docker's availability.
 */
export interface DevStackDependencies {
  /**
   * The run id this stack's state is keyed by.
   *
   * Overridable so a test gets a fresh directory per call; the real launcher uses
   * one id for the whole invocation.
   */
  runId: string;
  readVars: (path: string) => Record<string, string | undefined>;
  createService: (
    id: LocalServiceId,
    context: {
      origin: string;
      callerVars: Record<string, string | undefined>;
      environment: NodeJS.ProcessEnv;
      runId: string;
    },
  ) => Promise<LocalService>;
}

const devStackDependencies: DevStackDependencies = {
  runId: DEV_STACK_RUN_ID,
  readVars: (path: string): Record<string, string | undefined> =>
    parseEnv(readFileSync(path, 'utf8')),
  createService: async (id, context) => {
    const localContext: LocalServiceContext = {
      runId: context.runId,
      scope: runScope(context.runId, REPO_ROOT),
      origin: context.origin,
      callerVars: context.callerVars,
      environment: context.environment,
    };
    switch (id) {
      case 'supabase':
        return prepareSupabaseService({
          origin: context.origin,
          callerVars: context.callerVars,
          autoSignIn: devAutoSignInOffered(context.environment),
          environment: context.environment,
        });
      case 'stripe':
        return prepareStripeService(localContext);
      case 'container':
        return prepareContainerService(localContext);
      case 'jobs':
        return prepareJobsService(localContext);
      default:
        // Unreachable through `LocalServiceId`, which is why the switch can be
        // exhaustive. Named rather than defaulted so a fifth service cannot start
        // nothing.
        throw new Error(`No local service factory for "${String(id)}".`);
    }
  },
};

/**
 * What one stack run produced, and everything needed to end it.
 *
 * `varsContents` is carried rather than re-read at teardown so the file can be
 * removed only if it is still exactly what this run wrote — the same check
 * `removeOwnedVars` makes, and the reason a run cannot delete a file it no longer
 * owns.
 */
export interface DevStackRun {
  readonly services: LocalService[];
  /** The 0600 file the Worker is pointed at. Holds this run's credentials. */
  readonly varsPath: string;
  /** The exact contents written, so teardown can refuse to delete a changed file. */
  readonly varsContents: string;
  readonly summary: string[];
}

export const prepareDevStack = async (
  services: readonly LocalServiceId[],
  origin: string,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: Partial<DevStackDependencies> = {},
): Promise<DevStackRun> => {
  // The caller's configuration is spread across *two* places, and this merge is the
  // reason. The E2E and integration harnesses pass `SUPABASE_URL` and the anon key
  // in the environment and keep the service-role key in the vars file they own —
  // `dev_app_backend.test.ts` calls this the E2E lane's shape. Reading only the
  // environment calls that configuration incomplete and refuses, which is how
  // `bun run e2e` failed with "SUPABASE_URL is set but the backend is incomplete"
  // while every other check was green.
  const { runId, readVars, createService } = { ...devStackDependencies, ...dependencies };
  const callerVarsPath = environment.STARTER_DEV_VARS_PATH;
  const callerFile: Record<string, string | undefined> =
    callerVarsPath === undefined ? {} : readVars(callerVarsPath);

  // Environment values that are *set* override the file. Empty strings are
  // excluded, because an empty `SUPABASE_URL` in the environment must not shadow a
  // real one in the file and turn a working configuration into a refusal.
  const present = Object.fromEntries(
    Object.entries(environment).filter(
      ([, value]) => typeof value === 'string' && value.length > 0,
    ),
  );

  const context: LocalServiceContext = {
    runId,
    scope: runScope(runId, REPO_ROOT),
    origin,
    callerVars: { ...callerFile, ...present },
    environment,
  };

  const started = await startStack(services, (id) =>
    createService(id, { origin, callerVars: context.callerVars, environment, runId }),
  );

  // One file, written once, carrying every service's bindings **and the caller's**.
  //
  // The caller's own file is the channel `wrangler dev --env-file` reads
  // credentials from. The E2E lane starts its own Supabase, writes a 0600 file
  // with the three Supabase bindings, points `STARTER_DEV_VARS_PATH` at it, and
  // leaves the service-role key out of the environment on purpose. Its Supabase
  // service therefore reports "already complete" and contributes nothing — and a
  // stack file built only from services would then be pointed at the Worker
  // *instead of* the caller's, so every binding vanished and the Worker answered
  // 503 with "Supabase configuration is incomplete" for all three.
  //
  // So the caller's bindings are the base of this file, not a competitor to it. The
  // caller's own file is never written to or removed; only what this run wrote is.
  try {
    const merged = mergeServiceVars(started);

    // A service producing a binding the caller already supplied is the same
    // "two owners, one value" defect `mergeServiceVars` refuses between services,
    // and the consequence is identical: whichever wrote last is what the application
    // talks to. It should be unreachable — a caller who supplied a complete
    // configuration is the case where a service deliberately starts nothing — which
    // is exactly why an unreachable branch is worth a loud one.
    const contested = Object.keys(merged).filter((key) => callerFile[key] !== undefined);
    if (contested.length > 0) {
      throw new Error(
        `A local service set ${contested.join(', ')}, which this run's caller already configured ` +
          'in the file named by STARTER_DEV_VARS_PATH.\n' +
          '  Refusing rather than picking one: the application would talk to whichever wrote last.\n' +
          `  Caller file: ${callerVarsPath ?? '(none)'}\n` +
          '  Remove the binding from one of them.',
      );
    }

    const written = await writeOwnedVars(context.scope.dir, 'stack.dev.vars', {
      ...callerFile,
      // `DEPLOYMENT_ENV` and `APP_ORIGIN` describe the application, not any service,
      // so they are added here rather than by whichever service happens to be first.
      DEPLOYMENT_ENV: 'local',
      APP_ORIGIN: origin,
      ...merged,
    });

    return {
      services: started,
      varsPath: written.path,
      varsContents: written.contents,
      summary: started.flatMap((service) => [`${service.label}`, ...service.summary]),
    };
  } catch (error) {
    await disposeServices(started).catch(() => {});
    throw error;
  }
};

/**
 * Stop every service a stack started, in reverse order.
 *
 * Exported for the harness: a test that starts a real stack has to be able to end
 * it without reaching into `main`'s closure.
 */
export const disposeDevStack = async (run: DevStackRun): Promise<string[]> => {
  // The file first, and independently of the services. It holds this run's
  // credentials — a local Supabase service-role key, and a Stripe key when the
  // emulator is running — and leaving it behind after Ctrl-C means a credential
  // outlives the process that was entitled to it, sitting in `.wrangler/runs/`.
  // `removeOwnedVars` refuses to delete a file whose contents changed, so a run
  // that somehow no longer owns it leaves it for a human rather than destroying it.
  const failures: string[] = [];
  try {
    await removeOwnedVars(run.varsPath, run.varsContents);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  // Services are stopped even when the removal failed: a container that will not
  // stop is a different, more urgent problem than a leftover file.
  failures.push(...(await disposeServices(run.services)));
  return failures;
};

export const main = async (
  mode: DevMode = 'app',
  stack?: readonly LocalServiceId[],
): Promise<number> => {
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

  let stackRun: DevStackRun;
  try {
    stackRun = await prepareDevStack(stack ?? ['supabase'], origin);
  } catch (error) {
    // A missing prerequisite is reported as itself, with its own remedy, because
    // "your machine cannot run this" and "this code is broken" call for different
    // responses and collapsing them makes a refusal read as a bug.
    if (error instanceof LocalServiceUnavailable) {
      return fail(
        `The ${error.service} service is unavailable: ${error.prerequisite}.\n  ${error.remedy}`,
        EXIT.unavailable,
      );
    }
    return fail(
      `The dev stack could not be prepared: ${error instanceof Error ? error.message : String(error)}\n` +
        '  Local services need Docker or Podman. Run `bun run setup:doctor -- --profile database`,\n' +
        '  or set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY to use a project instead.',
      EXIT.unavailable,
    );
  }

  // The child reads the owned file: wrangler through `--env-file`, the Vite
  // platform proxy through this variable.
  applyBackendVarsPath(stackRun.varsPath);
  const server = buildTarget(mode, stackRun.varsPath);

  // Truncate rather than append: a run that appends to the previous run's log
  // makes `bun run logs web --mode local` report events from a process that is gone.
  writeFileSync(LOG_FILE, '');

  const log = createWriteStream(LOG_FILE, { flags: 'a' });

  process.stdout.write(
    `${server.label} -> ${origin}\n` +
      `${stackRun.summary.join('\n')}\n` +
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
  const teardownFailures = await disposeDevStack(stackRun);
  if (teardownFailures.length > 0) {
    for (const failure of teardownFailures) {
      process.stderr.write(`Dev backend teardown failed: ${failure}\n`);
    }
    return exitCode === EXIT.ok ? EXIT.failed : exitCode;
  }
  return exitCode;
};
