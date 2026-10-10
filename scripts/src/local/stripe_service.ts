// scripts/src/local/stripe_service.ts
//
// Stripe, locally, with the emulator's limits stated rather than discovered.
//
// **What stripe-mock is.** A container that answers the Stripe REST API with
// generated fixtures. Your SDK calls succeed, your request paths and response
// parsing run, and a checkout session comes back with a plausible object. That is
// real emulation and it is what makes `--stack stripe` worth having.
//
// **What it is not, and why this module says so out loud.** stripe-mock holds no
// state: every `POST` is accepted and discarded, so the ids it hands back are
// synthetic and refer to nothing on the next boot. And it does not deliver
// webhooks, at all. A developer who discovers either fact by waiting for a webhook
// that will never arrive has learned something important too late, so
// {@link STRIPE_MOCK_LIMITS} is part of this module's exported surface and every
// consumer of it — the dev banner, `stripe:setup`, the doctor — is expected to
// print it.
//
// **Webhooks need a second tool.** Getting an event from Stripe to a local process
// requires the Stripe CLI's `stripe listen`, which is a Go binary distributed
// through a package manager and *not* a workspace dependency. This repository pins
// what it can pin and refuses to shell out to whatever the machine has, so the
// bridge is opt-in: it is detected, and when it is absent the run says the bridge
// was not run and gives the install command. That is the whole reason
// {@link stripeBridgeStatus} exists as a separate question from "can this host run
// stripe-mock": the answer to the first is almost always yes.

import { REPO_ROOT } from '../shared/paths.ts';
import { publicToolEnvironment } from '../shared/private_environment.ts';
import { runBounded } from '../shared/run_bounded.ts';
import { allocatePort, isPortBusy } from '../shared/run_scope.ts';
import { containerRuntimeRemedy, resolveContainerRuntime } from './container_runtime.ts';
import { type LocalService, type LocalServiceContext, LocalServiceUnavailable } from './service.ts';

/**
 * The image to run.
 *
 * Overridable so a host can use a mirror, a proxy or a different version without
 * editing source, and the resolved value is printed in the banner so a run's
 * provenance is visible in the log. The default is a floating tag rather than a
 * digest because this repository cannot verify a digest from the checkout it was
 * written in, and shipping an unverified digest would be worse than shipping a tag
 * that is visible. Pin it in `STRIPE_MOCK_IMAGE` for a release build.
 */
export const stripeMockImage = (environment: NodeJS.ProcessEnv = process.env): string =>
  environment.STRIPE_MOCK_IMAGE ?? 'stripe/stripe-mock:latest';

/** The ports stripe-mock binds inside its own container. */
export const STRIPE_MOCK_CONTAINER_PORTS = { http: 12111, https: 12112 } as const;

/**
 * What the emulator does not do. Printed wherever the emulator is offered, because
 * an emulator that silently lacks a capability is indistinguishable from a bug in
 * the application until someone waits for the missing capability.
 */
export const STRIPE_MOCK_LIMITS = [
  'stripe-mock keeps no state: created products and prices exist only for the call that created them.',
  'stripe-mock delivers no webhooks. Event delivery needs the Stripe CLI bridge, reported separately.',
] as const;

/** A non-secret placeholder the Stripe SDK requires but the emulator never checks. */
export const STRIPE_MOCK_SECRET_KEY = 'sk_test_stripe_mock_local' as const;

/**
 * Whether the webhook bridge is available on this host.
 *
 * A status rather than a boolean because there are three outcomes worth telling
 * apart: present, absent, and present-but-unauthenticated. The third is the one
 * that otherwise wastes an afternoon — `stripe listen` starts, prints a forwarding
 * banner, and delivers nothing.
 */
export type StripeBridgeStatus =
  | { readonly available: true; readonly command: string }
  | { readonly available: false; readonly reason: string; readonly remedy: string };

export const stripeBridgeStatus = (
  environment: NodeJS.ProcessEnv = process.env,
  run: (command: string, args: readonly string[]) => number | null = defaultBridgeProbe,
): StripeBridgeStatus => {
  // An explicit override is the supported way to point at an installation this
  // probe cannot find (a Homebrew path, a mise shim).
  const configured = environment.STRIPE_CLI_BIN;
  if (configured !== undefined && configured.length > 0) {
    return run(configured, ['version']) === null
      ? {
          available: false,
          reason: `STRIPE_CLI_BIN=${configured} did not run.`,
          remedy: 'Unset STRIPE_CLI_BIN, or point it at a working `stripe` executable.',
        }
      : { available: true, command: configured };
  }

  const version = run('stripe', ['version']);
  if (version === null) {
    return {
      available: false,
      reason: 'The Stripe CLI is not on PATH, so no webhook can reach a local process.',
      remedy:
        'Install it (https://docs.stripe.com/stripe-cli), run `stripe login`, then re-run.\n' +
        '  Product and checkout calls work without it; only webhook delivery needs it.',
    };
  }

  // `stripe version` succeeds unauthenticated, so a green probe is not evidence
  // that `listen` will forward anything. Checking config is what distinguishes
  // "not logged in" from "ready", and it is cheap.
  const authenticated = run('stripe', ['config', '--list']) === 0;
  return authenticated
    ? { available: true, command: 'stripe' }
    : {
        available: false,
        reason:
          'The Stripe CLI is installed but not authenticated, so `stripe listen` would forward nothing.',
        remedy:
          'Run `stripe login`, then re-run. Set STRIPE_CLI_BIN if it is installed somewhere unusual.',
      };
};

const defaultBridgeProbe = (command: string, args: readonly string[]): number | null => {
  const result = Bun.spawnSync([command, ...args], {
    stdout: 'ignore',
    stderr: 'ignore',
    env: publicToolEnvironment(process.env),
  });
  return result.success ? 0 : null;
};

/** The collaborators, injectable so the decision is testable without an engine. */
export interface StripeServiceDependencies {
  resolveRuntime: typeof resolveContainerRuntime;
  allocatePort: typeof allocatePort;
  isPortBusy: typeof isPortBusy;
  /** `docker run --detach`; resolves to the container id or throws. */
  runContainer: (engine: string, args: readonly string[]) => Promise<string>;
  /** `docker rm --force`; resolves when the container is gone. */
  removeContainer: (engine: string, name: string) => Promise<void>;
  /** Resolves when `url` answers, throws on timeout. */
  waitForHttp: (url: string, timeoutMs: number) => Promise<void>;
  bridgeStatus: (environment: NodeJS.ProcessEnv) => StripeBridgeStatus;
}

const READY_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 120_000;

const runEngine = async (
  engine: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const result = await runBounded({
    command: engine,
    args: [...args],
    cwd: REPO_ROOT,
    env: publicToolEnvironment(process.env),
    timeoutMs,
    maxBytes: 1024 * 1024,
  });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
};

const runContainerDetached = async (engine: string, args: readonly string[]): Promise<string> => {
  const result = await runEngine(engine, ['run', '--detach', ...args], RUN_TIMEOUT_MS);
  if (result.code !== 0) {
    throw new Error(`stripe-mock did not start (exit ${result.code}).\n${result.stderr.trim()}`);
  }
  const id = result.stdout.trim();
  if (id.length === 0) {
    throw new Error('stripe-mock started but the container engine reported no container id.');
  }
  return id;
};

const removeContainerForced = async (engine: string, name: string): Promise<void> => {
  const result = await runEngine(engine, ['rm', '--force', '--volumes', name], 60_000);
  // `docker rm` on an already-removed container exits nonzero, which is not a
  // failure to clean up. Anything else is: the port is still bound.
  if (result.code !== 0 && !/no such container/i.test(`${result.stdout}${result.stderr}`)) {
    throw new Error(`Could not remove the stripe-mock container ${name}: ${result.stderr.trim()}`);
  }
};

const waitForHttp = async (url: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok || response.status === 401) {
        // 401 is stripe-mock answering correctly for an unauthenticated probe.
        return;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`stripe-mock did not answer ${url} within ${timeoutMs}ms: ${lastFailure}`);
};

const defaultDependencies: StripeServiceDependencies = {
  resolveRuntime: resolveContainerRuntime,
  allocatePort,
  isPortBusy,
  runContainer: runContainerDetached,
  removeContainer: removeContainerForced,
  waitForHttp,
  bridgeStatus: stripeBridgeStatus,
};

export interface StripeServiceResult extends LocalService {
  readonly id: 'stripe';
}

/**
 * The Stripe configuration a caller has already supplied, if it is complete.
 *
 * Both halves are required. A base URL with no key, or a key with no base, means
 * the caller is pointing at a real account through the SDK's default host — and
 * this service must not start an emulator underneath that, or the application
 * would silently bill a live test account through a stack the developer believes
 * is local.
 */
export const callerStripeValues = (
  callerVars: Readonly<Record<string, string | undefined>>,
): { apiBase: string; secretKey: string } | null => {
  const apiBase = (callerVars.STRIPE_API_BASE ?? '').trim();
  const secretKey = (callerVars.STRIPE_SECRET_KEY ?? '').trim();
  return apiBase.length > 0 && secretKey.length > 0 ? { apiBase, secretKey } : null;
};

export const prepareStripeService = async (
  context: LocalServiceContext,
  overrides: Partial<StripeServiceDependencies> = {},
): Promise<StripeServiceResult> => {
  const dependencies = { ...defaultDependencies, ...overrides };

  const configured = callerStripeValues(context.callerVars);
  if (configured !== null) {
    return {
      id: 'stripe',
      label: 'Stripe (caller account)',
      owned: false,
      vars: {
        STRIPE_API_BASE: configured.apiBase,
        STRIPE_SECRET_KEY: configured.secretKey,
      },
      summary: [`Stripe API -> ${configured.apiBase} (configured by this run's caller)`],
      dispose: async () => [],
    };
  }

  const engine = dependencies.resolveRuntime(context.environment);
  if (engine === null) {
    throw new LocalServiceUnavailable(
      'stripe',
      'a container engine to run stripe-mock',
      containerRuntimeRemedy,
    );
  }

  // Two purposes, not one port twice: `allocatePort` already salts by purpose, so
  // asking twice for distinct purposes gives two independent candidates and a
  // reported collision points at one of them by name.
  const http = await dependencies.allocatePort('stripe-mock-http', REPO_ROOT);
  const https = await dependencies.allocatePort('stripe-mock-https', REPO_ROOT);

  const name = `starter-stripe-mock-${context.runId}`.slice(0, 64);
  const image = stripeMockImage(context.environment);

  const containerId = await dependencies.runContainer(engine.command, [
    '--name',
    name,
    // Bound to loopback explicitly. A container port published on all interfaces
    // exposes a fake payment API to the local network, which is a genuinely bad
    // thing to hand to a developer who expected localhost.
    '--publish',
    `127.0.0.1:${http.port}:${STRIPE_MOCK_CONTAINER_PORTS.http}`,
    '--publish',
    `127.0.0.1:${https.port}:${STRIPE_MOCK_CONTAINER_PORTS.https}`,
    '--label',
    `io.starter.run=${context.runId}`,
    image,
  ]);

  const apiBase = `http://127.0.0.1:${http.port}`;
  try {
    await dependencies.waitForHttp(`${apiBase}/v1/plans`, READY_TIMEOUT_MS);
  } catch (error) {
    // The container is this run's, so a service that cannot become ready must not
    // be left running: it would hold its ports and answer the next run's probes.
    await dependencies.removeContainer(engine.command, name).catch(() => {});
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `  Container ${containerId} was removed so it does not hold ${http.port}.`,
    );
  }

  const bridge = dependencies.bridgeStatus(context.environment);
  const summary = [
    `Stripe emulator (stripe-mock) -> ${apiBase}`,
    `  image ${image} via ${engine.command}`,
    ...STRIPE_MOCK_LIMITS.map((limit) => `  ${limit}`),
    bridge.available
      ? `  Webhook bridge available: run \`stripe listen --forward-to ${context.origin}/api/webhooks/stripe\``
      : `  Webhook delivery NOT RUN — ${bridge.reason}\n  ${bridge.remedy}`,
  ];

  return {
    id: 'stripe',
    label: 'Stripe emulator',
    owned: true,
    vars: {
      STRIPE_API_BASE: apiBase,
      STRIPE_SECRET_KEY: STRIPE_MOCK_SECRET_KEY,
    },
    summary,
    dispose: async () => {
      try {
        await dependencies.removeContainer(engine.command, name);
      } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
      }
      // Verified rather than assumed. A container that survived `rm --force` holds
      // a port the next run's probe will fail on, and the operator needs it named
      // now rather than as a confusing bind error three commands later.
      if (await dependencies.isPortBusy(http.port)) {
        return [
          `stripe-mock was removed but ${http.port} is still bound. ` +
            `Inspect container ${name} and stop it.`,
        ];
      }
      return [];
    },
  };
};
