// scripts/src/registry/service_registry.ts
//
// What this repository's applications are, and what kind of thing each one is.
//
// The question this answers is "what is `media`?", and the answer is not
// derivable from a directory name. `apps/frontend/client` is the only thing with
// a public route. `apps/backend/jobs` has none and is only reachable through a
// Workflow binding. `apps/backend/media` is not an application at all — it is a
// container image, and the only thing that runs it is the jobs Worker. A tool
// that reads those three paths and treats them uniformly will eventually try to
// give one of them an origin, or to start one of them with `wrangler dev`, and
// the failure will surface as a deploy step that does nothing.
//
// **What this deliberately does not hold.** Resource identity — Worker names,
// bucket names, origins — belongs to `EnvironmentTargets` in `app_registry.ts`,
// which is per environment and read from the gitignored overlay. This registry
// says *what kind of thing an app is*; that one says *where this environment's
// copy of it lives*. Both were once called "config" and merged, and the merged
// version could not answer either question without also answering the wrong one.
//
// The deploy phase list is declared here and checked against `apply.ts` by
// `service_registry.test.ts` rather than imported from it. Importing would make
// this module and the pipeline depend on each other's load order, and the list is
// short enough that a test is the cheaper place to catch a divergence.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { planeOf } from '../guards/policy.ts';
import { LOCAL_SERVICE_IDS, type LocalServiceId } from '../local/service.ts';
import { REPO_ROOT } from '../shared/paths.ts';

/**
 * What kind of deployable something is.
 *
 * The kind is what determines the *shape* of everything downstream: how it is
 * built, whether it has an origin, whether it can be given an `--env-file`, and
 * whether starting it locally makes sense at all. Adding a kind is therefore a
 * deliberate act that forces those answers to be written down, which is the
 * point — `apps/backend/analytics` is unclassified until somebody says what it
 * is, exactly as an unclassified file is refused until a plane is assigned.
 */
export const SERVICE_KINDS = [
  /** The public application. One origin, HTML, assets and `/api/*`. */
  'web-worker',
  /** Workflows dispatch. No public route; reached only through a binding. */
  'jobs-worker',
  /** A container image, executed by something else. Not started, never reachable. */
  'container-job',
  /** Build tooling and harnesses. Deployed nowhere. */
  'cli',
] as const;

export type ServiceKind = (typeof SERVICE_KINDS)[number];

/** The deploy phases a service can take part in. Mirrors `PHASES` in `deploy/apply.ts`. */
export const SERVICE_PHASES = [
  'schema',
  'storage',
  'image',
  'jobs',
  'web',
  'verify',
  'record',
] as const;

export type ServicePhase = (typeof SERVICE_PHASES)[number];

export interface ServiceConfig {
  /** The registry id. Matches `AppId` where the two overlap. */
  readonly id: string;
  /** Repository-relative. Checked to exist and to be classified. */
  readonly path: string;
  readonly kind: ServiceKind;
  /** Short, stable name used in log lines, image tags and `--only` selectors. */
  readonly shortName: string;
  /**
   * Local services that must be running for this one to be exercised locally.
   *
   * A dependency edge, and the reason `--stack jobs` starts a database rather than
   * a jobs Worker with nothing behind it. Empty for anything with no local runtime
   * requirement, which is honest for `native` and `e2e`.
   */
  readonly requires: readonly LocalServiceId[];
  /** Deploy phases this service participates in. */
  readonly phases: readonly ServicePhase[];
  /**
   * True when the deployable has a public origin and can therefore be verified by
   * an HTTP request after a deploy.
   *
   * The reason `verify` is in the phase list of only some entries, and the reason
   * a jobs Worker cannot be given a URL to poll.
   */
  readonly addressable: boolean;
  /**
   * Whether this project's sources are part of the module graph `bun run guard`
   * resolves.
   *
   * False only for the Rust media crate, and stated rather than inferred. The
   * architecture guard parses `.ts`, `.tsx` and `.svelte`; Rust is validated by
   * `cargo check`/`cargo test` in its own lane, and a guard that parsed it would be
   * a second, weaker answer to a question the compiler already answers. The
   * consequence is that no plane covers `apps/backend/media`, so a blanket
   * "classified?" check would report a deliberate decision as a missing one.
   */
  readonly analysed: boolean;
}

/**
 * The registry.
 *
 * `web` is the only `addressable` service, and that is a property of the
 * architecture rather than a temporary state: the jobs Worker returns 404 to every
 * request by design, because dispatching compute is not something the internet
 * gets to ask for.
 */
export const SERVICE_REGISTRY = {
  web: {
    id: 'web',
    path: 'apps/frontend/client',
    kind: 'web-worker',
    shortName: 'web',
    requires: ['supabase'],
    phases: ['schema', 'storage', 'web', 'verify', 'record'],
    addressable: true,
    analysed: true,
  },
  jobs: {
    id: 'jobs',
    path: 'apps/backend/jobs',
    kind: 'jobs-worker',
    shortName: 'jobs',
    requires: ['supabase', 'container'],
    phases: ['image', 'jobs', 'verify'],
    addressable: false,
    analysed: true,
  },
  media: {
    id: 'media',
    path: 'apps/backend/media',
    kind: 'container-job',
    shortName: 'media',
    requires: ['container'],
    phases: ['image'],
    addressable: false,
    // Rust, not TypeScript. See `analysed` above.
    analysed: false,
  },
  native: {
    id: 'native',
    path: 'apps/frontend/native',
    kind: 'cli',
    shortName: 'native',
    requires: [],
    phases: [],
    addressable: false,
    analysed: true,
  },
  e2e: {
    id: 'e2e',
    path: 'apps/e2e',
    kind: 'cli',
    shortName: 'e2e',
    requires: ['supabase'],
    phases: [],
    addressable: false,
    analysed: true,
  },
} as const satisfies Record<string, ServiceConfig>;

export type ServiceId = keyof typeof SERVICE_REGISTRY;

export const SERVICE_IDS = Object.keys(SERVICE_REGISTRY) as readonly ServiceId[];

export const isServiceId = (value: unknown): value is ServiceId =>
  typeof value === 'string' && Object.hasOwn(SERVICE_REGISTRY, value);

/** One registered service, by id, or an explicit refusal. */
export const serviceById = (id: string): ServiceConfig | undefined =>
  isServiceId(id) ? SERVICE_REGISTRY[id] : undefined;

/**
 * Every local service some member of `ids` needs, deduplicated and ordered.
 *
 * A set rather than an array because the same service is reachable from several
 * apps — `media` and `jobs` both require `container` — and starting stripe-mock
 * twice would bind the same port twice. Order follows the registry so a developer
 * reading the banner sees a stable sequence.
 */
export const requiredLocalServices = (ids: readonly string[]): LocalServiceId[] => {
  const wanted = new Set<LocalServiceId>();
  for (const id of ids) {
    for (const service of serviceById(id)?.requires ?? []) {
      wanted.add(service);
    }
  }
  return LOCAL_SERVICE_IDS.filter((service) => wanted.has(service));
};

/**
 * The services a local stack must start, in start order.
 *
 * Ordered rather than a set because startup is not commutative: Supabase is seeded
 * before anything that reads it, and the image is built before the jobs Worker that
 * dispatches to it. `LOCAL_SERVICE_IDS` is the declared order and this function
 * preserves it, so the order lives in exactly one list.
 */
export const orderedLocalServices = (services: readonly LocalServiceId[]): LocalServiceId[] => {
  const wanted = new Set(services);
  return LOCAL_SERVICE_IDS.filter((service) => wanted.has(service));
};

/** A problem with the registry, with the fix. */
export interface RegistryProblem {
  readonly subject: string;
  readonly problem: string;
  readonly remedy: string;
}

/**
 * Check the registry against the filesystem and the architecture policy.
 *
 * Run by the `registry-valid` guard and by `service_registry.test.ts`. Three
 * checks, each for a failure that would otherwise be silent:
 *
 *   1. every path exists — an entry for a directory nobody created is a plan that
 *      deploys nothing and reports success;
 *   2. every path has a plane — an unclassified path is one the architecture guard
 *      cannot check anything about, so a registry entry and a guard blind spot
 *      would arrive together;
 *   3. every `requires` and phase names something that exists — a typo in a local
 *      service id starts one service fewer than the developer asked for.
 */
export const serviceRegistryProblems = (root: string = REPO_ROOT): RegistryProblem[] => {
  const problems: RegistryProblem[] = [];

  // Widened deliberately. `SERVICE_REGISTRY` is `as const`, so iterating it
  // directly makes every field a literal and lets the compiler conclude — before
  // this function has looked at anything — that the checks below are vacuous. The
  // widened view is what lets them actually run.
  const registry: Record<string, ServiceConfig> = SERVICE_REGISTRY;

  for (const config of Object.values(registry)) {
    if (!existsSync(join(root, config.path))) {
      problems.push({
        subject: config.id,
        problem: `${config.path} does not exist, so deploying "${config.id}" would do nothing.`,
        remedy: `Create ${config.path}, or remove the "${config.id}" entry from SERVICE_REGISTRY.`,
      });
      continue;
    }

    // The trailing slash matters. Every directory rule in `PLANE_PLACEMENTS` is a
    // prefix ending in `/`, because it classifies *files inside* the directory —
    // so `planeOf('apps/e2e')` is null while `planeOf('apps/e2e/')` is `node`, and
    // checking the bare path reported a real, classified app as unclassified.
    if (config.analysed && planeOf(`${config.path}/`) === null) {
      problems.push({
        subject: config.id,
        problem: `${config.path} has no plane in PLANE_PLACEMENTS, so no boundary of it can be checked.`,
        remedy: 'Add a row for it in scripts/src/guards/policy.ts naming its runtime.',
      });
    }

    for (const service of config.requires) {
      if (!(LOCAL_SERVICE_IDS as readonly string[]).includes(service)) {
        problems.push({
          subject: config.id,
          problem: `requires unknown local service "${String(service)}".`,
          remedy: `Known services: ${LOCAL_SERVICE_IDS.join(', ')}.`,
        });
      }
    }

    for (const phase of config.phases) {
      if (!(SERVICE_PHASES as readonly string[]).includes(phase)) {
        problems.push({
          subject: config.id,
          problem: `declares unknown deploy phase "${String(phase)}".`,
          remedy: `Known phases: ${SERVICE_PHASES.join(', ')}.`,
        });
      }
    }

    // A service that can be verified over HTTP must be one that answers one. The
    // jobs Worker returns 404 to everything, and putting it in `verify` would
    // produce a deploy that verifies successfully against a service that cannot
    // serve a request.
    if (config.addressable && config.kind !== 'web-worker') {
      problems.push({
        subject: config.id,
        problem: `is addressable but its kind is "${config.kind}", which has no public route.`,
        remedy: 'Set addressable to false, or change the kind to web-worker.',
      });
    }
  }

  return problems;
};
