// scripts/src/local/supabase_service.ts
//
// Local Supabase, as one service among several.
//
// The allocate → start → seed sequence lives here and nowhere else. It used to be
// inline in `prepareDevBackend` in `dev-app.ts`, which was correct when Supabase
// was the only thing `bun run dev` started. With Stripe, a container and a jobs
// Worker joining it, a second service needing the same sequence would mean a
// second copy — and the copies would differ in which step ran when, which is
// exactly the kind of difference nobody notices until teardown leaves a port
// bound.
//
// `prepareDevBackend` in `dev-app.ts` is now a thin wrapper over this module, so
// the E2E and integration harnesses that call it directly keep the exact contract
// they already depend on: the same collaborator sequence, the same bindings, the
// same teardown order.

import { DEV_SEED_ACCOUNT } from '@starter/fixtures';
import { seedSupabaseLocal } from '../db/seed_supabase.ts';
import {
  devSupabaseAllocation,
  discardSupabaseData,
  hasSupabaseOwnership,
  preservedSupabaseVolumes,
  probeRunningSupabase,
  readSupabaseOwnership,
  type SupabaseLocalAllocation,
  startSupabaseLocal,
  stopSupabaseLocal,
  supabaseProjectDir,
} from '../db/supabase_local.ts';
import { supabaseBin } from '../deploy/providers/supabase.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import { reportStep, type Stepper } from '../shared/progress.ts';
import type { LocalService } from './service.ts';

/** The three bindings the application refuses to start without. */
const BACKEND_KEYS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

/**
 * The collaborators this service uses.
 *
 * Injectable so the decision — provision a stack, or respect the project the
 * caller named — is reachable from a test without a container engine. The
 * defaults are the real ones; a test that swaps them is testing this decision
 * rather than Docker's availability.
 */
export interface SupabaseServiceDependencies {
  /**
   * The per-checkout allocation this service starts a database under.
   *
   * One entry, deliberately, and it is the shared one: a pid-derived allocation
   * would make every run compute a different project id, so nothing could ever be
   * adopted. The id's blast radius is documented on `DEV_SHARED_STACK_RUN_ID`.
   */
  allocate: typeof devSupabaseAllocation;
  start: typeof startSupabaseLocal;
  seed: typeof seedSupabaseLocal;
  /** Reads an already-running stack's bindings, or null. */
  probe: typeof probeRunningSupabase;
  hasOwnership: typeof hasSupabaseOwnership;
  readOwnership: typeof readSupabaseOwnership;
  stop: typeof stopSupabaseLocal;
  /** This project's volumes, stopped or not. How "your data came back" is decided. */
  listVolumes: typeof preservedSupabaseVolumes;
  /** Removes those volumes. Only `--fresh` calls this. */
  discard: typeof discardSupabaseData;
}

const defaultDependencies: SupabaseServiceDependencies = {
  allocate: devSupabaseAllocation,
  start: startSupabaseLocal,
  seed: seedSupabaseLocal,
  probe: probeRunningSupabase,
  hasOwnership: hasSupabaseOwnership,
  readOwnership: readSupabaseOwnership,
  stop: stopSupabaseLocal,
  listVolumes: preservedSupabaseVolumes,
  discard: discardSupabaseData,
};

export interface PrepareSupabaseOptions {
  readonly origin: string;
  /**
   * A vars file the caller owns and this run must not replace.
   *
   * The E2E lane passes the URL and anon key in the environment and keeps the
   * service-role key in the file, so deciding on the environment alone would call
   * a working configuration incomplete and then drop a credential it depends on.
   */
  readonly callerVars?: Readonly<Record<string, string | undefined>>;
  /** Whether this run may sign requests in as the seeded account. */
  readonly autoSignIn: boolean;
  /**
   * Whether an already-running database from an earlier run may be adopted.
   *
   * Defaults to true, because that is what makes the second `bun run dev` fast, and
   * the adoption is guarded rather than optimistic: the stack is only used when it
   * is this checkout's own project id *and* its API answers.
   *
   * Set false to force a clean one. A caller that needs a database it can be certain
   * is pristine — a lane comparing row counts, anything asserting on seeded state —
   * sets it rather than relying on there happening to be nothing running.
   */
  readonly reuse?: boolean;
  /**
   * Throw this checkout's development data away and start over.
   *
   * Two things have to be true for this to mean what it says, and both are here
   * rather than in the caller:
   *
   *   * **No adoption.** A running stack is not adopted, and is stopped first —
   *     otherwise "fresh" would be a database with last run's rows in it, which is
   *     the one thing the word is meant to exclude.
   *   * **No restoration.** The volumes a previous `db:stop` kept are removed before
   *     the start, because a preserved volume is reattached automatically and would
   *     otherwise hand the fresh boot the previous database.
   *
   * What it leaves behind is a database with this checkout's migrations replayed
   * and the mock seed in it, which is the only honest reading of "fresh".
   */
  readonly fresh?: boolean;
  /**
   * Reports each slow step of starting and seeding this stack.
   *
   * Required, for the reason `LocalServiceContext.progress` states: this service
   * spends the longest silent stretch in the whole workspace, and it is the one a
   * developer is most likely to interrupt. A `Stepper` scoped to this service, so
   * its steps are not nested under a service starting beside it.
   */
  readonly progress: Stepper;
  readonly dependencies?: Partial<SupabaseServiceDependencies>;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

/** A prepared Supabase service, plus the allocation `prepareDevBackend` writes for. */
export interface SupabaseServiceResult extends LocalService {
  readonly id: 'supabase';
  /**
   * The allocation this run created, or `undefined` when the caller's own project
   * is in use.
   *
   * Present so the wrapper can write a vars file bound to *this* stack. Its
   * absence is the signal not to write one at all.
   */
  readonly allocation: SupabaseLocalAllocation | undefined;
}

/** The Supabase bindings a caller has already placed, if any. */
export const callerSupabaseValues = (
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const present = BACKEND_KEYS.filter((name) => (environment[name] ?? '').trim().length > 0);
  return Object.fromEntries(present.map((name) => [name, environment[name] as string]));
};

/** Missing keys of a partial backend, naming which ones rather than the count. */
const missingKeys = (values: Record<string, string | undefined>): string[] =>
  BACKEND_KEYS.filter((name) => (values[name] ?? '').trim().length === 0);

/**
 * Whether to offer the seeded account to this run.
 *
 * Not for a harness. The visual and browser lanes start this same launcher with
 * `E2E_RUN_ID` set and drive the result to photograph or assert pages; signing
 * their requests in would change what the lanes observe, and a lane that quietly
 * observed something else is worse than no lane. A developer's `bun run dev`
 * carries no such identity, so it gets the convenience.
 */
export const devAutoSignInOffered = (environment: NodeJS.ProcessEnv = process.env): boolean =>
  (environment.E2E_RUN_ID ?? '').trim().length === 0;

/**
 * Remove everything a previous run left of this checkout's database.
 *
 * Two steps, and the order is load-bearing. A running stack's volumes are mounted,
 * and the engine refuses to remove a volume in use — so stopping it first is what
 * keeps `--fresh` from failing with a container error on a host that is working
 * perfectly well. The volumes that follow are the ones `bun run db:stop` kept, and
 * which `supabase start` would otherwise reattach: leaving them would make "fresh"
 * a database with the previous run's rows still in it.
 *
 * A failure here throws, and the caller lets it. A `--fresh` that started on top of
 * data it failed to remove would report a fresh database and be lying.
 */
const discardPreviousData = async (
  allocation: SupabaseLocalAllocation,
  dependencies: SupabaseServiceDependencies,
  progress: Stepper,
): Promise<void> => {
  const owned = (await dependencies.hasOwnership(allocation))
    ? await dependencies.readOwnership(allocation)
    : null;

  // Probed rather than assumed: the ownership file records that a stack was
  // started, not that it is still up, and stopping one that is not running would
  // report a teardown failure for a database that was already gone.
  if (owned !== null && (await dependencies.probe(allocation)) !== null) {
    await reportStep(progress, 'stopping the running database', () =>
      dependencies.stop(allocation, owned, { preserveData: false }),
    );
  }

  await reportStep(
    progress,
    'discarding the previous development data',
    () => Promise.resolve(dependencies.discard(allocation)),
    (removed) => (removed.length === 0 ? 'nothing to discard' : removed.join(', ')),
  );
};

export const prepareSupabaseService = async (
  options: PrepareSupabaseOptions,
): Promise<SupabaseServiceResult> => {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const environment = options.environment ?? process.env;

  // Already complete across the two places a caller can put bindings: its own
  // vars file, and the environment.
  const inherited: Record<string, string | undefined> = {
    ...options.callerVars,
    ...callerSupabaseValues(environment),
  };

  if (missingKeys(inherited).length === 0) {
    return {
      id: 'supabase',
      label: 'Supabase (caller project)',
      owned: false,
      allocation: undefined,
      vars: {},
      summary: [`Supabase project -> ${inherited.SUPABASE_URL ?? ''}`],
      dispose: async () => [],
    };
  }

  // A named project that is missing keys is a configuration error, not a request
  // for a local stack: starting one here would silently serve a different database
  // than the operator named.
  if (inherited.SUPABASE_URL !== undefined) {
    throw new Error(
      `SUPABASE_URL is set but the backend is incomplete: ${missingKeys(inherited).join(', ')}. ` +
        'Set every one of SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY, ' +
        'or unset SUPABASE_URL to run against a local stack.',
    );
  }

  // The per-checkout allocation, not a per-run one. This is the line that makes
  // reuse reachable at all: with a pid-derived id, every run computed a different
  // project id, so the probe below looked for a stack that had never existed and
  // the next run booted its own. `DEV_SHARED_STACK_RUN_ID` states the blast radius —
  // this service and nothing else — and the lanes that need a pristine database
  // allocate their own.
  const allocation = dependencies.allocate(REPO_ROOT);

  const fresh = options.fresh === true;

  if (fresh) {
    await discardPreviousData(allocation, dependencies, options.progress);
  }

  // A development run adopts the database an earlier one already started, and this
  // is the only reason the second `bun run dev` is quick.
  //
  // The adoption is one-way on purpose. A reused stack outlives the run that
  // started it, so `owned` is `false` for it and teardown never stops it — a stack
  // this run did not start is not this run's to take down, which is the same rule
  // that stops `bun run dev` killing a database a developer started by other means.
  // What stops it is `bun run db:stop`, or the next full boot, and both are explicit.
  const reused =
    fresh || options.reuse === false
      ? null
      : await reportStep(
          options.progress,
          'looking for a database already running',
          () => dependencies.probe(allocation),
          (found) => (found === null ? undefined : 'adopted'),
        );

  if (reused !== null) {
    return {
      id: 'supabase',
      label: 'Local Supabase (reused)',
      owned: false,
      allocation,
      vars: {
        ...reused,
        // Only for a developer's own run. A harness reusing this stack must not be
        // signed in as the seeded account — `devAutoSignInOffered` is what decides,
        // and it is decided once rather than per-binding here.
        ...(options.autoSignIn
          ? {
              DEV_AUTO_LOGIN: 'seed',
              DEV_AUTO_LOGIN_EMAIL: DEV_SEED_ACCOUNT.email,
              DEV_AUTO_LOGIN_PASSWORD: DEV_SEED_ACCOUNT.password,
            }
          : {}),
      },
      summary: [
        `Local Supabase (already running) -> ${reused.SUPABASE_URL}`,
        `  Studio -> ${allocation.urls.studio}`,
        ...(options.autoSignIn
          ? [
              `Signed in automatically as ${DEV_SEED_ACCOUNT.email}. ` +
                'Sign out on /notes to use the sign-in form instead.',
            ]
          : []),
        '  Left running: Ctrl-C stops the app, not this. Stop it with `bun run db:stop`.',
      ],
      dispose: async () => [],
    };
  }

  // The volumes this checkout's database still holds, read at the last moment
  // before the start makes the question unanswerable.
  //
  // `supabase start` reattaches a kept volume, so afterwards the engine would report
  // volumes whether or not there had been any — and this boot would claim to have
  // "restored" a database it had just created. It is also *after* the reuse probe
  // rather than before it: a run that adopts a running stack does not need to know,
  // and asking anyway would spend a `docker volume ls` on the fast path.
  const volumesBefore = dependencies.listVolumes(allocation);

  // Email confirmations off: a developer's own loop should reach the app after
  // sign-up. The verified-email flow is covered by the E2E lane, which turns
  // confirmations on because it redeems real links.
  let started: Awaited<ReturnType<SupabaseServiceDependencies['start']>>;
  let seeded: Awaited<ReturnType<SupabaseServiceDependencies['seed']>>;
  try {
    started = await dependencies.start(allocation, {
      emailConfirmations: false,
      progress: options.progress,
    });

    // Seed the stack this run started, so the developer's first page shows their own
    // notes rather than an empty list they have to type into. `--workdir` the
    // generated project directory, because `supabase status` reads the project id
    // and ports out of the config in there — pointing it at the repository root
    // names a different stack, which is why `bun run db:seed` cannot see this one.
    //
    // A failure here fails the command. A dev server that starts against an empty
    // database and says nothing is the failure mode this repository treats as worse
    // than an error.
    seeded = await reportStep(
      options.progress,
      'seeding the demo account',
      () =>
        dependencies.seed({
          root: supabaseProjectDir(allocation),
          // The run directory has no manifest of its own, so the binary is resolved
          // from the checkout that declares it rather than from the directory being
          // seeded.
          binary: supabaseBin() ?? undefined,
        }),
      (result) => `${result.noteCount} notes`,
    );
  } catch (error) {
    try {
      if (await dependencies.hasOwnership(allocation)) {
        // `preserveData` is not passed, and that is the point: a stack that failed
        // to start must not leave a volume behind for the next run to restore. The
        // data it would preserve is the previous run's, and this stack never reached
        // a state where anyone could rely on either.
        await dependencies.stop(allocation, await dependencies.readOwnership(allocation));
      }
    } catch {
      // Cleanup must not replace the startup or seed failure.
    }
    throw error;
  }

  const vars: Record<string, string> = { ...started };
  if (options.autoSignIn) {
    // The seeded credential is a local stack value like the anon and service-role
    // keys beside it: in the owned 0600 file, never in argv and never in the
    // environment of the spawned server. `seed` is the mode word
    // `apps/frontend/client/src/lib/server/dev_auto_login.ts` accepts and nothing
    // else; that module is the reader, this is the writer, and neither infers it.
    vars.DEV_AUTO_LOGIN = 'seed';
    vars.DEV_AUTO_LOGIN_EMAIL = DEV_SEED_ACCOUNT.email;
    vars.DEV_AUTO_LOGIN_PASSWORD = DEV_SEED_ACCOUNT.password;
  }

  const summary = [
    fresh
      ? `Local Supabase (fresh database, started by this run) -> ${started.SUPABASE_URL}`
      : `Local Supabase (started by this run) -> ${started.SUPABASE_URL}`,
    `  Studio -> ${allocation.urls.studio}`,
    // Said rather than inferred. A developer who stopped the database yesterday and
    // has today's rows on their first screen needs to know *why*, and the alternative
    // — silently reusing a volume — is indistinguishable from a bug report about
    // deleted notes coming back.
    ...(volumesBefore.length > 0
      ? [
          `Restored the data from ${volumesBefore.length === 1 ? 'the volume kept by the last run' : `${volumesBefore.length} volumes kept by earlier runs`}.`,
          '  Start over instead: bun run dev --fresh',
        ]
      : []),
    `Seeded account -> ${DEV_SEED_ACCOUNT.email} (${seeded.noteCount} notes)`,
    ...(options.autoSignIn
      ? [
          `Signed in automatically as ${DEV_SEED_ACCOUNT.email}. ` +
            'Sign out on /notes to use the sign-in form instead.',
        ]
      : []),
    // Said here rather than left to be discovered: this run is about to end and the
    // database is about to still be here.
    '  Left running for the next `bun run dev`. Stop it with `bun run db:stop`.',
  ];

  return {
    id: 'supabase',
    label: 'Local Supabase',
    // Owned, and *not* stopped at teardown.
    //
    // This is the one place `owned` and "will be torn down" come apart, so it is
    // worth being explicit about why. The database is a property of the checkout,
    // not of the run: the next `bun run dev` adopts it and starts in about a second
    // instead of thirty. Stopping it on Ctrl-C would make the second run pay the
    // full boot again and make reuse unreachable, which is the whole point of
    // starting it.
    //
    // The cost is eight containers outliving the command that started them, which
    // this repository otherwise treats as a defect — so the cost is bounded and
    // named: one per checkout, keyed by a fixed id rather than a pid, always
    // reported in the banner, and stopped by exactly one command. `db:stop` refuses
    // rather than reporting success when there is nothing to stop.
    //
    // `db stop` and the failure path above are the ways it does get stopped, so a
    // stack that is failing to start is still cleaned up.
    owned: true,
    allocation,
    vars,
    summary,
    dispose: async () => [],
  };
};
