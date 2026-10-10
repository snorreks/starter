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
  allocateSupabaseLocal,
  hasSupabaseOwnership,
  readSupabaseOwnership,
  type SupabaseLocalAllocation,
  startSupabaseLocal,
  stopSupabaseLocal,
  supabaseProjectDir,
} from '../db/supabase_local.ts';
import { supabaseBin } from '../deploy/providers/supabase.ts';
import { REPO_ROOT } from '../shared/paths.ts';
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
  allocate: typeof allocateSupabaseLocal;
  start: typeof startSupabaseLocal;
  seed: typeof seedSupabaseLocal;
  hasOwnership: typeof hasSupabaseOwnership;
  readOwnership: typeof readSupabaseOwnership;
  stop: typeof stopSupabaseLocal;
}

const defaultDependencies: SupabaseServiceDependencies = {
  allocate: allocateSupabaseLocal,
  start: startSupabaseLocal,
  seed: seedSupabaseLocal,
  hasOwnership: hasSupabaseOwnership,
  readOwnership: readSupabaseOwnership,
  stop: stopSupabaseLocal,
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

  const allocation = dependencies.allocate(
    REPO_ROOT,
    `dev_${process.pid}_${crypto.randomUUID().slice(0, 8)}`,
  );

  // Email confirmations off: a developer's own loop should reach the app after
  // sign-up. The verified-email flow is covered by the E2E lane, which turns
  // confirmations on because it redeems real links.
  const started = await dependencies.start(allocation, { emailConfirmations: false });

  // Seed the stack this run started, so the developer's first page shows their own
  // notes rather than an empty list they have to type into. `--workdir` the
  // generated project directory, because `supabase status` reads the project id
  // and ports out of the config in there — pointing it at the repository root
  // names a different stack, which is why `bun run db:seed` cannot see this one.
  //
  // A failure here fails the command. A dev server that starts against an empty
  // database and says nothing is the failure mode this repository treats as worse
  // than an error.
  const seeded = await dependencies.seed({
    root: supabaseProjectDir(allocation),
    // The run directory has no manifest of its own, so the binary is resolved from
    // the checkout that declares it rather than from the directory being seeded.
    binary: supabaseBin() ?? undefined,
  });

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
    `Local Supabase (started by this run) -> ${started.SUPABASE_URL}`,
    `  Studio -> ${allocation.urls.studio}`,
    `Seeded account -> ${DEV_SEED_ACCOUNT.email} (${seeded.noteCount} notes)`,
    ...(options.autoSignIn
      ? [
          `Signed in automatically as ${DEV_SEED_ACCOUNT.email}. ` +
            'Sign out on /notes to use the sign-in form instead.',
        ]
      : []),
  ];

  return {
    id: 'supabase',
    label: 'Local Supabase',
    owned: true,
    allocation,
    vars,
    summary,
    dispose: async () => {
      // Independent steps, and both attempted. A failure to stop must not leave
      // the stack running because the vars file happened to be stuck, and vice
      // versa; the caller turns the returned list into a failed exit.
      const failures: string[] = [];
      try {
        if (await dependencies.hasOwnership(allocation)) {
          await dependencies.stop(allocation, await dependencies.readOwnership(allocation));
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
      return failures;
    },
  };
};
