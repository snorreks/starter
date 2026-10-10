// scripts/src/local/service.ts
//
// One lifecycle for every local service, and the rules that keep N of them
// composable.
//
// The problem this exists to solve: `bun run dev` used to have exactly one thing
// to start, local Supabase, and that one thing's allocate/start/seed/teardown
// sequence was written inline in `prepareDevBackend`. Adding Stripe, a container
// and a jobs Worker means four services, and the naive shape — a `stripe_local.ts`
// and a `docker_local.ts` each with their own allocate/start/dispose — produces
// four answers to "who owns this port", "what happens when one fails to start",
// and "in what order do these stop", and they will not agree.
//
// So there is one interface, one merge rule and one teardown order, and each
// service is a factory that fills them in. A service cannot invent its own
// ownership story because ownership is a field of the return value, not of the
// code that made it.
//
// **Why a refusal is a thrown `LocalServiceUnavailable` rather than a boolean.**
// A missing container engine is not a failure of the command; it is a fact about
// the host, and the caller has to be able to say which prerequisite is absent and
// what to install. A boolean loses that, and a `skip` flag turns "your machine
// cannot run this" into a command that exits zero having done nothing — the one
// outcome this repository treats as worse than an error.

import type { RunScope } from '../shared/run_scope.ts';

/**
 * The local services this repository knows how to start.
 *
 * A closed union on purpose: the stack resolver, the registry and the guard all
 * validate against this, so a service nobody declared a factory for is refused at
 * assembly rather than ignored. An open string would make a typo in a stack
 * definition silently start one fewer service than the developer asked for.
 */
export const LOCAL_SERVICE_IDS = ['supabase', 'stripe', 'container', 'jobs'] as const;

export type LocalServiceId = (typeof LOCAL_SERVICE_IDS)[number];

export const isLocalServiceId = (value: unknown): value is LocalServiceId =>
  typeof value === 'string' && (LOCAL_SERVICE_IDS as readonly string[]).includes(value);

/** What a service needs to know about the run it is joining. */
export interface LocalServiceContext {
  /**
   * Identifies this run across every service, so two checkouts and two runs get
   * different ports and different state directories.
   */
  readonly runId: string;
  /** The run's directories. Every service writes inside its own subdirectory. */
  readonly scope: RunScope;
  /** The public origin the application is served on, for links a service reports. */
  readonly origin: string;
  /**
   * Bindings the caller has already placed in the environment or in a vars file
   * they own.
   *
   * A service that finds its configuration already complete does nothing and
   * reports `owned: false`. That is the rule that makes `--stack stripe` respect a
   * real Stripe account the developer configured, rather than starting an
   * emulator over the top of it.
   */
  readonly callerVars: Readonly<Record<string, string | undefined>>;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

/**
 * A prerequisite for this operation is not available on this host.
 *
 * Carries the missing prerequisite and the remedy separately because the caller
 * prints both and a reader acts on the second one.
 */
export class LocalServiceUnavailable extends Error {
  constructor(
    readonly service: LocalServiceId,
    readonly prerequisite: string,
    readonly remedy: string,
  ) {
    super(`The ${service} local service needs ${prerequisite}, which this host does not have.`);
    this.name = 'LocalServiceUnavailable';
  }
}

/**
 * What a started (or deliberately not started) service contributes to the run.
 *
 * `vars` is the whole contract with the application: a service that sets up
 * something the application cannot reach has failed, and this shape makes that
 * unrepresentable — there is no side channel for a service to use instead.
 */
export interface LocalService {
  readonly id: LocalServiceId;
  /** One word for the banner, e.g. `stripe-mock`. */
  readonly label: string;
  /**
   * True when this run started it and is therefore responsible for stopping it.
   *
   * False means the caller's own project or emulator is in use. Teardown must
   * never stop something this run did not start, or `bun run dev` would take down
   * a developer's long-running database on their way out.
   */
  readonly owned: boolean;
  /** Bindings to write into the run-owned vars file. */
  readonly vars: Readonly<Record<string, string>>;
  /** Lines for the developer, naming what was started and where to reach it. */
  readonly summary: readonly string[];
  /**
   * Release everything, returning failure descriptions.
   *
   * Never throws: the caller is tearing down, the child process is already gone,
   * and a throw here would skip every service after this one. The exit code still
   * reflects the failure — the stack turns a non-empty array into a failed run.
   */
  dispose(): Promise<string[]>;
}

export type LocalServiceFactory = (context: LocalServiceContext) => Promise<LocalService>;

/**
 * Combine services' bindings, refusing rather than overwriting.
 *
 * Two services both writing `STRIPE_SECRET_KEY` is a defect in the registry, not
 * a runtime race, and the safe outcome is to stop: a last-writer-wins merge would
 * leave the application talking to whichever service happened to start last, with
 * a key belonging to the other. The message names both services because "a value
 * is defined twice" is not actionable on its own.
 */
export const mergeServiceVars = (services: readonly LocalService[]): Record<string, string> => {
  const merged: Record<string, string> = {};
  const owner: Record<string, LocalServiceId> = {};

  for (const service of services) {
    for (const [key, value] of Object.entries(service.vars)) {
      const previous = owner[key];
      if (previous !== undefined) {
        throw new Error(
          `Local services "${previous}" and "${service.id}" both define ${key}.\n` +
            '  Two services writing one binding leaves the application talking to ' +
            'whichever started last.\n' +
            `  Give one of them a different binding, or drop ${key} from the one that does not own it.`,
        );
      }
      owner[key] = service.id;
      merged[key] = value;
    }
  }

  return merged;
};

/**
 * Dispose in reverse order, running every one even when an earlier one fails.
 *
 * Reverse order because a service is stopped after the things that use it: the
 * jobs Worker goes before the container it dispatches to, which goes before
 * Supabase. Every one runs because a container that will not stop must not leave
 * a database running, and the caller's exit code is decided from the returned
 * list rather than from the first throw.
 */
export const disposeServices = async (services: readonly LocalService[]): Promise<string[]> => {
  const failures: string[] = [];
  for (const service of [...services].reverse()) {
    try {
      failures.push(...(await service.dispose()));
    } catch (error) {
      // A dispose that throws despite the contract is still reported, still does
      // not stop the remaining services, and is attributed to the service it came
      // from so the operator knows which one is holding a port.
      failures.push(`${service.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
};
