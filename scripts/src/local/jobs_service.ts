// scripts/src/local/jobs_service.ts
//
// The jobs Worker, running locally in real workerd.
//
// Workflows is the reason this service is worth having. The jobs Worker's whole
// job is to own Workflow instances, and Workflows exists only inside workerd —
// so a jobs Worker run anywhere else is a Node program with three interfaces
// declared and none of them provided. Running it through `wrangler dev` gives it
// the real ones.
//
// **What local execution still cannot do, and what this service says about it.**
// `JOBS_PROFILE=encode` makes the Worker dispatch to the Cloud Run Jobs API over
// HTTPS with a Google OAuth token. There is no local emulator for that, and
// inventing one that answered `200` would be a lie with a port on it: the request
// would be shaped correctly and nothing would ever encode. So this service
// chooses its profile from what the host can actually run, and when it cannot
// run `encode` it says so in the banner rather than starting a Worker that
// appears to be dispatching.
//
// The finite runner itself is not mocked anywhere in this path. `bun run
// test:compute` drives a real FFmpeg encode through the real image, and
// `--stack container` builds that image from current sources. What is missing
// here is the Cloud Run *transport*, and the banner says exactly that.

import { type ChildProcess, spawn } from 'node:child_process';
import { killTree } from '@starter/utils/process';
import { JOBS_DIR, JOBS_DIR_RELATIVE, REPO_ROOT } from '../shared/paths.ts';
import { publicToolEnvironment } from '../shared/private_environment.ts';
import { allocatePort, type PortAllocation } from '../shared/run_scope.ts';
import { wranglerBin } from '../shared/tools.ts';
import { type LocalService, type LocalServiceContext, LocalServiceUnavailable } from './service.ts';
import { removeOwnedVars, writeOwnedVars } from './vars_file.ts';

const JOBS_ENTRY = 'src/index.ts';
const READY_TIMEOUT_MS = 60_000;

/**
 * The bindings `JOBS_PROFILE=encode` requires before the Worker will boot.
 *
 * Copied as *names* from `apps/backend/jobs/src/env.ts`'s `requireJobsBindings`
 * rather than as values, and deliberately incomplete for that reason: this list
 * answers "could this host plausibly dispatch?", and the Worker remains the
 * authority that answers "did it?". A full list here would be a second one that
 * drifts.
 */
export const ENCODE_DISPATCH_SIGNALS = [
  'GOOGLE_DISPATCHER_CREDENTIAL',
  'GOOGLE_PROJECT',
  'GOOGLE_REGION',
  'CLOUD_RUN_JOB',
] as const;

export type JobsLocalProfile = 'disabled' | 'encode';

export interface JobsProfileDecision {
  readonly profile: JobsLocalProfile;
  /** Present when the profile is not what a developer would expect; names what is missing. */
  readonly missing: readonly string[];
}

/**
 * Choose the profile from the host, and report the evidence.
 *
 * An explicit `JOBS_PROFILE` set by the caller is honoured whatever is missing —
 * the caller knows something this function cannot, and second-guessing them would
 * start a Worker they did not ask for. The decision is only made when nothing was
 * set, so it cannot silently override configuration.
 */
export const decideJobsProfile = (
  environment: NodeJS.ProcessEnv = process.env,
): JobsProfileDecision => {
  const configured = environment.JOBS_PROFILE?.trim();
  if (configured === 'encode' || configured === 'disabled') {
    return { profile: configured, missing: [] };
  }
  const missing = ENCODE_DISPATCH_SIGNALS.filter(
    (name) => (environment[name] ?? '').trim().length === 0,
  );
  return missing.length === 0
    ? { profile: 'encode', missing: [] }
    : { profile: 'disabled', missing };
};

export interface JobsServiceDependencies {
  allocatePort: typeof allocatePort;
  wranglerBin: typeof wranglerBin;
  decideProfile: typeof decideJobsProfile;
  /** Resolves when the Worker answers, throws on timeout. */
  waitUntilServing: (origin: string, timeoutMs: number) => Promise<void>;
}

export interface JobsServiceResult extends LocalService {
  readonly id: 'jobs';
  readonly origin: string;
}

const waitUntilServing = async (origin: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(2_000) });
      // The jobs Worker has no public route by design: `fetch` answers every path
      // with 404 and `cache-control: no-store`. Seeing exactly that proves the
      // Worker booted inside workerd with its bindings bound — a 502 from the dev
      // server, or a hang, means it did not, and neither would be distinguishable
      // from "started fine" without this check.
      if (response.status === 404 && response.headers.get('cache-control') === 'no-store') {
        return;
      }
      lastFailure = `unexpected answer HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `The jobs Worker did not answer on ${origin} within ${timeoutMs}ms: ${lastFailure}\n` +
      '  It has no public route, so a serving answer is 404 with cache-control: no-store.\n' +
      `  Run it directly to see why:  bun run --cwd ${JOBS_DIR_RELATIVE} dev`,
  );
};

export const prepareJobsService = async (
  context: LocalServiceContext,
  overrides: Partial<JobsServiceDependencies> = {},
): Promise<JobsServiceResult> => {
  const dependencies = { ...defaultDependencies, ...overrides };

  const binary = dependencies.wranglerBin();
  if (binary === null) {
    throw new LocalServiceUnavailable(
      'jobs',
      'wrangler, to serve the jobs Worker in workerd',
      'Run `bun install` from the repository root: wrangler is a pinned workspace dependency of apps/frontend/client.',
    );
  }

  const decision = dependencies.decideProfile(context.environment);
  const port: PortAllocation = await dependencies.allocatePort('jobs-worker', REPO_ROOT);
  const origin = `http://127.0.0.1:${port.port}`;

  // `detached: false` so the Worker stays in this process group and is torn down
  // with the dev server, rather than surviving it and holding its port. See the
  // same choice, and the same reason, in `dev-app.ts`.
  // Nonsecret configuration travels as vars; anything secret travels in an owned
  // file. `publicToolEnvironment` strips `GOOGLE_DISPATCHER_CREDENTIAL` precisely
  // because it is a credential, and `--var` would put its value in argv — the one
  // place this repository never lets a secret reach.
  const vars: Record<string, string> = {
    DEPLOYMENT_ENV: 'local',
    JOBS_PROFILE: decision.profile,
  };
  for (const name of ENCODE_DISPATCH_SIGNALS) {
    const value = context.environment[name] ?? context.callerVars[name];
    if (value !== undefined && value.length > 0) {
      vars[name] = value;
    }
  }
  const owned = await writeOwnedVars(context.scope.dir, 'jobs.dev.vars', vars);

  const child: ChildProcess = spawn(
    binary,
    [
      'dev',
      JOBS_ENTRY,
      '--port',
      String(port.port),
      '--ip',
      '127.0.0.1',
      '--local',
      '--env-file',
      owned.path,
    ],
    {
      cwd: JOBS_DIR,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: publicToolEnvironment(context.environment),
    },
  );

  const log: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => log.push(chunk.toString()));

  const exited = new Promise<never>((_resolve, reject) => {
    child.once('error', (error) => reject(error));
    child.once('exit', (code, signal) =>
      reject(
        new Error(
          `The jobs Worker exited before it served (${signal ?? `code ${code ?? 'unknown'}`}).\n${log.join('').slice(-2000)}`,
        ),
      ),
    );
  });

  try {
    await Promise.race([waitUntilServing(origin, READY_TIMEOUT_MS), exited]);
  } catch (error) {
    if (child.pid !== undefined) {
      killTree(child.pid, { graceMs: 300, attempts: 10 });
    }
    throw error;
  }

  const summary = [
    `Jobs Worker (workerd) -> ${origin} [JOBS_PROFILE=${decision.profile}]`,
    decision.profile === 'encode'
      ? '  Encode dispatch will call the Cloud Run Jobs API with the configured Google identity.'
      : [
          `  Encode dispatch NOT RUN — Cloud Run has no local emulator, and these are absent: ${decision.missing.join(', ')}.`,
          '  The Worker still runs in real workerd, so Workflows, R2 and env resolution are exercised.',
          '  To exercise the runner itself: `bun run test:compute` (real FFmpeg) or `--stack container`.',
        ].join('\n    '),
    '  The jobs Worker has no public route; 404 with cache-control: no-store is the correct answer.',
  ];

  return {
    id: 'jobs',
    label: 'Jobs Worker',
    owned: true,
    origin,
    vars: {},
    summary,
    dispose: async () => {
      // Both steps always run: a file that survives would carry a dispatcher
      // credential into the next run on this checkout, and a surviving process
      // would hold the port. Independent failures are both reported.
      const failures: string[] = [];
      try {
        await removeOwnedVars(owned.path, owned.contents);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const survivors = killTree(child.pid, { graceMs: 300, attempts: 25 });
        if (survivors.length > 0) {
          failures.push(
            `The jobs Worker left ${survivors.join(', ')} running; it may still hold ${port.port}.`,
          );
        }
      }
      return failures;
    },
  };
};

const defaultDependencies: JobsServiceDependencies = (() => ({
  allocatePort,
  wranglerBin,
  decideProfile: decideJobsProfile,
  waitUntilServing,
}))();
