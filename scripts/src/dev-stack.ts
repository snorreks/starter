// scripts/src/dev-stack.ts
//
// What `bun run dev` starts, decided by name instead of by editing code.
//
// The problem this solves: `bun run dev` used to mean exactly one thing, and it
// was hardcoded. Adding Stripe, the finite runner image and the jobs Worker meant
// four possibilities — no services, one service, two services, all of them — and
// the choices a developer actually wants to make ("just the app against a real
// database", "the whole thing so I can see a job run") have no way to be written
// down. So they are named here, and any combination of service ids is also a
// valid answer.
//
// **Why a stack resolves to a refusal rather than to a default.** `bun run dev`
// with no arguments used to start Supabase, which was unambiguous. With four
// services it is not: a stack that silently picked "everything" would start a
// container build on a laptop that was only trying to look at a page, and a stack
// that silently picked "nothing" would serve 503s. Both are worse than asking,
// so a non-interactive invocation is refused with the exact command to run, and
// only an interactive terminal is offered the choice.
//
// **Why `client` still exists and is not the default for automation.** It is the
// historical behaviour, and the visual and browser lanes depend on it. Naming it
// keeps that dependency visible instead of implicit.

import {
  disposeServices,
  isLocalServiceId,
  LOCAL_SERVICE_IDS,
  type LocalService,
  type LocalServiceId,
  mergeServiceVars,
} from './local/service.ts';
import { requiredLocalServices } from './registry/service_registry.ts';

/**
 * Named stacks.
 *
 * Each entry is a list of **services**, not of flags, so a stack reads as what
 * will be running. `services` is expanded through the registry's `requires` at
 * resolution time, which is why `--stack jobs` brings up a database without
 * anybody writing `supabase` into it by hand and getting it wrong later.
 */
export const DEV_STACKS = {
  /**
   * The historical `bun run dev`: a local database and nothing else.
   *
   * `client` and `supabase` start the same services, and that is deliberate
   * rather than an oversight: `bun run dev` always serves the application, so
   * there is no stack in which a database is running and no app is too. The two
   * names are kept because both are what people reach for — "I want the client"
   * and "just the database" — and each is described by what it will actually do
   * rather than by a service list that looks like a coincidence.
   */
  client: { services: ['supabase'], detail: 'a local database and the app; the default' },
  supabase: { services: ['supabase'], detail: 'a local database only, no Stripe or containers' },
  stripe: {
    services: ['supabase', 'stripe'],
    detail: 'adds stripe-mock; holds no state and delivers no webhooks',
  },
  container: {
    services: ['supabase', 'container'],
    detail: 'adds the finite runner image, built from current sources',
  },
  jobs: {
    services: ['supabase', 'container', 'jobs'],
    detail: 'adds the jobs Worker in workerd, with Workflows bindings',
  },
  full: {
    services: ['supabase', 'stripe', 'container', 'jobs'],
    detail: 'everything: app, database, Stripe, image and jobs Worker',
  },
} as const satisfies Record<
  string,
  { readonly services: readonly LocalServiceId[]; readonly detail: string }
>;

export type DevStackName = keyof typeof DEV_STACKS;

export const DEV_STACK_NAMES = Object.keys(DEV_STACKS) as readonly DevStackName[];

export const isDevStackName = (value: unknown): value is DevStackName =>
  typeof value === 'string' && Object.hasOwn(DEV_STACKS, value);

/** What a stack resolution produced, or why it refused. */
export type StackResolution =
  | {
      readonly ok: true;
      readonly name: string;
      /** After registry expansion: the services that will actually start, in order. */
      readonly services: readonly LocalServiceId[];
      /** The apps whose `requires` pulled these services in. Names the reason. */
      readonly fromApps: readonly string[];
    }
  | { readonly ok: false; readonly problem: string; readonly remedy: string };

/**
 * Parse `--stack` into a service list.
 *
 * A comma-separated list is accepted because "I want the app plus Stripe" is the
 * second most common thing anybody asks for, and making it two flags means the two
 * halves can be typed in an order that produces a different set.
 *
 * Refuses an unknown name rather than skipping it. `--stack supres` starting the
 * database and reporting success is the exact failure this repository treats as
 * worse than an error.
 */
export const parseStackSpec = (spec: string): StackResolution => {
  const tokens = spec
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return {
      ok: false,
      problem: 'No stack was named.',
      remedy: `Name one of: ${DEV_STACK_NAMES.join(', ')}. Or combine services: ${LOCAL_SERVICE_IDS.join(', ')}.`,
    };
  }

  const named = tokens.filter(isDevStackName);
  const unknown = tokens.filter((token) => !isDevStackName(token));
  if (unknown.length > 0) {
    return {
      ok: false,
      problem: `Unknown ${unknown.length === 1 ? 'stack' : 'stacks'}: ${unknown.join(', ')}.`,
      remedy:
        `Named stacks: ${DEV_STACK_NAMES.join(', ')}.\n` +
        `  Individual services: ${LOCAL_SERVICE_IDS.join(', ')}.\n` +
        '  Combine them: --stack supabase,stripe',
    };
  }

  const services = new Set<LocalServiceId>();
  for (const name of named) {
    for (const service of DEV_STACKS[name].services) {
      services.add(service);
    }
  }
  // Tokens that are service ids rather than stack names are a legitimate
  // combination, so they are added. The predicate is written as one narrowing
  // function because two `.filter` calls cannot carry a narrowing across them,
  // and an unnarrowed `string` cannot be added to a set of service ids.
  const isBareService = (token: string): token is LocalServiceId =>
    !isDevStackName(token) && isLocalServiceId(token);
  const bare = tokens.filter(isBareService);
  for (const service of bare) {
    services.add(service);
  }
  const loose = tokens.filter((token) => !isDevStackName(token) && !isLocalServiceId(token));
  if (loose.length > 0) {
    return {
      ok: false,
      problem: `Unknown ${loose.length === 1 ? 'service' : 'services'}: ${loose.join(', ')}.`,
      remedy:
        `Services: ${LOCAL_SERVICE_IDS.join(', ')}.\n` +
        `  Named stacks: ${DEV_STACK_NAMES.join(', ')}.`,
    };
  }

  return { ok: true, name: named.join('+'), services: [...services], fromApps: [] };
};

/**
 * Resolve a stack for one application.
 *
 * The app's own `requires` are always added, whatever was named: `--stack stripe`
 * against the web app means Stripe *and* the database it reads customers from, and
 * a stack that quietly omitted it would give the developer a checkout page that
 * 503s on save.
 *
 * The default is `['web']` — the application `bun run dev` actually serves — and
 * not "every app in the registry". Expanding from the whole registry meant naming
 * a Stripe stack also started a container build, because the *jobs* Worker requires
 * one, and the developer never asked for jobs. A stack is what you asked for plus
 * what *this* app needs, not what the repository contains.
 */
export const resolveStack = (
  spec: string | undefined,
  appIds: readonly string[] = ['web'],
): StackResolution => {
  const named = spec === undefined ? undefined : parseStackSpec(spec);
  if (named !== undefined && !named.ok) {
    return named;
  }

  const services = new Set<LocalServiceId>(named?.ok === true ? named.services : []);
  const fromApps = requiredLocalServices(appIds);
  for (const service of fromApps) {
    services.add(service);
  }

  const ordered = LOCAL_SERVICE_IDS.filter((service) => services.has(service));
  return {
    ok: true,
    name: named?.ok === true ? named.name : 'registry',
    services: ordered,
    fromApps: appIds,
  };
};

export type StackFactory = (id: LocalServiceId) => Promise<LocalService>;

/**
 * Start a stack and hand back everything the caller needs.
 *
 * Failure part-way through disposes what already started, in reverse, before
 * rethrowing. Leaving a database running behind a failed `bun run dev` is how a
 * developer ends up with three orphaned stacks and no idea which port is theirs.
 */
export const startStack = async (
  services: readonly LocalServiceId[],
  factory: StackFactory,
): Promise<LocalService[]> => {
  const started: LocalService[] = [];
  try {
    for (const id of services) {
      started.push(await factory(id));
    }
  } catch (error) {
    const failures = await disposeServices(started);
    for (const failure of failures) {
      process.stderr.write(`  while unwinding: ${failure}\n`);
    }
    throw error;
  }
  return started;
};

/** The banner lines, in start order, plus the merged bindings. */
export const describeStack = (
  services: readonly LocalService[],
): { vars: Record<string, string>; summary: string[] } => ({
  vars: mergeServiceVars(services),
  summary: services.flatMap((service) => [service.label, ...service.summary]),
});

/**
 * One line per selectable option, for `--help` and for the interactive prompt.
 *
 * Built from the registry rather than written out, so a service that is added to
 * `DEV_STACKS` appears in the menu without a second edit.
 */
export const stackChoices = (): {
  id: DevStackName;
  services: readonly LocalServiceId[];
  detail: string;
}[] =>
  DEV_STACK_NAMES.map((name) => ({
    id: name,
    services: [...DEV_STACKS[name].services],
    detail: DEV_STACKS[name].detail,
  }));
