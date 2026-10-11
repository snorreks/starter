// scripts/src/local/stripe_service.ts
//
// Stripe, locally, against Stripe's own test mode.
//
// **Why there is no container here any more.** This used to run `stripe-mock`: a
// container that answers the Stripe REST API with generated fixtures and keeps
// nothing. It was honest about that — `STRIPE_MOCK_LIMITS` was printed wherever it
// was offered — and it was still the wrong default, because a stateless mock cannot
// exercise the two things billing actually consists of: an object you created being
// there on the next request, and a webhook arriving because something happened.
// Pointing the same code at `https://api.stripe.com` with an `sk_test_` key gets
// both, against the real API version, with nothing to install.
//
// **So this service starts nothing.** There is no container, no port and no image.
// What it does instead is the work the container was standing in for — deciding
// whether a Stripe target is configured, refusing one that would do damage, proving
// the credentials work before the developer finds out at the checkout button, and
// telling them how webhooks reach this process. A service that starts nothing still
// belongs in the stack, because a refusal is better than a 503 twenty seconds later.
//
// **Webhooks are the Stripe CLI, and always were.** `stripe listen` subscribes
// directly to the test account and forwards real events to a local port; there is
// no dashboard endpoint to register. The CLI is a Go binary from a package manager
// that this repository does not pin and will not install, so it is **detected, not
// assumed** — see {@link stripeBridgeStatus} for why that distinction is three
// states and not a boolean.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLIENT_DIR } from '../shared/paths.ts';
import { publicToolEnvironment } from '../shared/private_environment.ts';
import { reportStep } from '../shared/progress.ts';
import { type LocalService, type LocalServiceContext, LocalServiceUnavailable } from './service.ts';

/**
 * The Stripe API. The default, and the only value a real test account uses.
 *
 * Named rather than inlined because the whole point of this service is that the
 * base URL and the key are a pair: `api.stripe.com` with `sk_live_` is production
 * billing, and a loopback host is a self-hosted emulator with different limits.
 * Pairing them is {@link stripeTargetProblem}'s job.
 */
export const STRIPE_API_BASE_DEFAULT = 'https://api.stripe.com';

/**
 * What a local stripe-mock still does not do.
 *
 * Kept after the emulator left the stack, and printed by `bun run stripe:setup`,
 * because a developer can still point `STRIPE_API_BASE` at one they started
 * themselves — and because that command's refusal against a local target is only
 * honest if it says what "local" costs.
 */
export const STRIPE_MOCK_LIMITS = [
  'stripe-mock keeps no state: created products and prices exist only for the call that created them.',
  'stripe-mock delivers no webhooks. Event delivery needs the Stripe CLI bridge, reported separately.',
] as const;

export interface StripeCredentials {
  readonly apiBase: string;
  readonly secretKey: string;
}

/** True when this points at something running on this machine rather than at Stripe. */
export const isLocalStripeTarget = (apiBase: string): boolean => {
  try {
    const { hostname } = new URL(apiBase);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
};

/**
 * Which mode a key is in, from its prefix.
 *
 * `rk_` and `whsec_` are refused by {@link stripeTargetProblem} for a different
 * reason and are not "unknown keys" here — they are keys of the wrong kind.
 */
export const stripeKeyMode = (secretKey: string): 'test' | 'live' | 'restricted' | 'unknown' => {
  if (secretKey.startsWith('sk_test_')) {
    return 'test';
  }
  if (secretKey.startsWith('sk_live_')) {
    return 'live';
  }
  if (secretKey.startsWith('rk_')) {
    return 'restricted';
  }
  return 'unknown';
};

/**
 * Why these two values cannot be used together, or `null` when they can.
 *
 * Returned rather than thrown so the caller decides how loudly to say it, and so
 * every rule is in one testable place. The order matters: a *live* key is refused
 * before its base URL is judged, because the key is the thing that can do damage.
 *
 * **A live key is refused outright, with no override.** `bun run dev` is a local
 * development stack; pointing one at live mode means a click on a checkout button
 * creates a real subscription and a real invoice. Staging and production are
 * deployed through `bun run deploy`, which has its own credential channel, and
 * Stripe's test mode is a complete environment for everything a development run
 * does — so there is no workflow this refuses that Stripe's test keys cannot do.
 */
export const stripeTargetProblem = (credentials: StripeCredentials): string | null => {
  const mode = stripeKeyMode(credentials.secretKey);
  if (mode === 'live') {
    return (
      'STRIPE_SECRET_KEY is a live-mode key (sk_live_…).\n' +
      '  Refusing: `bun run dev` would create real subscriptions and real invoices from a\n' +
      '  checkout click. Nothing in a local run needs live mode.\n' +
      '  Use a test key (sk_test_…) from https://dashboard.stripe.com/test/apikeys, which\n' +
      '  exercises the same API with no money attached.'
    );
  }
  if (mode === 'restricted') {
    return (
      'STRIPE_SECRET_KEY is a restricted key (rk_…).\n' +
      '  Refusing: the SDK signs requests with a secret key, and a restricted key cannot.\n' +
      '  Use the secret test key from https://dashboard.stripe.com/test/apikeys.'
    );
  }
  if (mode === 'unknown') {
    return (
      'STRIPE_SECRET_KEY does not start with `sk_test_`.\n' +
      '  Refusing rather than trying it: an unrecognised key is a typo, a publishable key, or\n' +
      '  something that should not be in a development run at all.\n' +
      '  Test secret keys are at https://dashboard.stripe.com/test/apikeys.'
    );
  }
  if (isLocalStripeTarget(credentials.apiBase) && stripeKeyMode(credentials.secretKey) === 'test') {
    return null;
  }
  try {
    const url = new URL(credentials.apiBase);
    if (url.protocol !== 'https:' && !isLocalStripeTarget(credentials.apiBase)) {
      return (
        `STRIPE_API_BASE is ${credentials.apiBase}, which is not HTTPS.\n` +
        '  Refusing: a secret key sent over plaintext can be read off the wire. Use\n' +
        `  ${STRIPE_API_BASE_DEFAULT}, or a loopback host.`
      );
    }
  } catch {
    return `STRIPE_API_BASE is not a URL: ${JSON.stringify(credentials.apiBase)}.`;
  }
  return null;
};

/**
 * Read the developer's Stripe configuration from the same sources the dev server reads.
 *
 * **Why this reads `.env` rather than only `context.callerVars`.** The Vite platform
 * proxy loads `.env`, `.env.local` and the run-owned vars file
 * (`apps/frontend/client/vite.config.ts`) and merges the process environment on top.
 * A service that consulted only the last two would refuse with "no Stripe
 * configured" for a developer who had done the obvious thing and put their test key
 * in `.env.local` — and the app they were trying to start *would* have worked. A
 * check that disagrees with what it is checking is worse than no check.
 *
 * Precedence is the order vite applies: `.env`, then `.env.local`, then whatever the
 * caller configured — which `prepareDevStack` has already merged from the run-owned
 * vars file and the process environment, environment winning. Last writer wins, so an
 * explicit environment variable beats a dotenv default.
 */
export const developerStripeConfig = (
  callerVars: Readonly<Record<string, string | undefined>> = {},
  read: (path: string) => Record<string, string | undefined> = readDotenv,
): StripeCredentials | null => {
  const sources: readonly Readonly<Record<string, string | undefined>>[] = [
    read(join(CLIENT_DIR, '.env')),
    read(join(CLIENT_DIR, '.env.local')),
    callerVars,
  ];

  let apiBase = STRIPE_API_BASE_DEFAULT;
  let secretKey = '';
  for (const source of sources) {
    const base = source.STRIPE_API_BASE?.trim();
    const key = source.STRIPE_SECRET_KEY?.trim();
    if (base !== undefined && base.length > 0) {
      apiBase = base;
    }
    if (key !== undefined && key.length > 0) {
      secretKey = key;
    }
  }
  return secretKey.length === 0 ? null : { apiBase, secretKey };
};

const readDotenv = (path: string): Record<string, string | undefined> => {
  try {
    return parseDotenv(readFileSync(path, 'utf8'));
  } catch {
    // A missing `.env.local` is the normal case for a fresh clone, not a problem.
    return {};
  }
};

/** `KEY=value`, tolerating quotes and comments the way dotenv does. */
export const parseDotenv = (contents: string): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = {};
  for (const line of contents.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null || (match[1] as string).startsWith('#')) {
      continue;
    }
    let value = match[2] ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[match[1] as string] = value;
  }
  return out;
};

export type StripeVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: string; readonly remedy: string };

/**
 * Prove the credentials work, by asking Stripe.
 *
 * **Why this is here and not at the checkout button.** `bun run dev --stack stripe`
 * that starts successfully and then answers every checkout with a 401 has wasted
 * the developer's time in the least recoverable way: the failure surfaces only when
 * they click something. One unauthenticated read costs milliseconds and moves the
 * failure to the start of the run, next to the thing that has to be fixed.
 *
 * **`/v1/products?limit=1` rather than `/v1/account`.** The account endpoint is
 * deprecated in recent API versions and answering 404 to a valid key would be
 * indistinguishable from answering 401 here. A product list is the cheapest read
 * that any test key can do.
 */
export const verifyStripeCredentials = async (
  credentials: StripeCredentials,
  options: {
    readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  } = {},
): Promise<StripeVerification> => {
  const request = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await request(`${credentials.apiBase}/v1/products?limit=1`, {
      headers: { authorization: `Bearer ${credentials.secretKey}` },
      // Bounded, because this runs during startup: a Stripe that accepts the
      // connection and never answers would otherwise hang `bun run dev` forever,
      // which is the one outcome an indicator must not produce.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return {
      ok: false,
      problem: `Could not reach ${credentials.apiBase}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      remedy:
        'Check the network. `bun run dev --stack stripe` talks to Stripe over HTTPS, so it needs one.',
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      problem: `Stripe rejected STRIPE_SECRET_KEY (HTTP ${response.status}).`,
      remedy:
        'The key is wrong, revoked, or from a different account than you think. Test keys are at\n' +
        '  https://dashboard.stripe.com/test/apikeys — a live key is refused, not tried.',
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      problem: `Stripe answered HTTP ${response.status} to a read the key should authorise.`,
      remedy:
        'This is a Stripe-side or network problem, not a credential problem. Try again shortly.',
    };
  }
  return { ok: true };
};

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

/** The collaborators, injectable so the decision is testable without a network. */
export interface StripeServiceDependencies {
  configure: typeof developerStripeConfig;
  verify: typeof verifyStripeCredentials;
  bridgeStatus: (environment: NodeJS.ProcessEnv) => StripeBridgeStatus;
}

const defaultDependencies: StripeServiceDependencies = {
  configure: developerStripeConfig,
  verify: verifyStripeCredentials,
  bridgeStatus: stripeBridgeStatus,
};

export interface StripeServiceResult extends LocalService {
  readonly id: 'stripe';
}

/** The exact command that forwards this run's webhooks, and where its secret goes. */
export const webhookBridgeInstructions = (
  origin: string,
  bridge: StripeBridgeStatus,
): readonly string[] => {
  if (!bridge.available) {
    return [`  Webhook delivery NOT RUN — ${bridge.reason}`, `    ${bridge.remedy}`];
  }
  return [
    `  Webhooks: ${bridge.command} listen --forward-to ${origin}/api/webhooks/stripe`,
    '    It prints a signing secret (whsec_…) on start. Put it in STRIPE_WEBHOOK_SECRET',
    '    in .env.local and restart this run; until you do, deliveries are refused, not',
    '    accepted unverified. To fire one by hand: stripe trigger payment_intent.succeeded',
  ];
};

/**
 * Decide whether this run can talk to Stripe, and refuse if it cannot.
 *
 * Starts nothing, so the two refusals here are the entire service. Both name the
 * missing thing and the way to get it, because a `--stack stripe` that exits with
 * "unavailable" and no remedy is the outcome this repository treats as worse than
 * an error.
 */
export const prepareStripeService = async (
  context: LocalServiceContext,
  overrides: Partial<StripeServiceDependencies> = {},
): Promise<StripeServiceResult> => {
  const dependencies = { ...defaultDependencies, ...overrides };

  const configured = dependencies.configure(context.callerVars);
  if (configured === null) {
    throw new LocalServiceUnavailable(
      'stripe',
      'a Stripe test secret key',
      [
        "This stack points at Stripe's own test mode rather than an emulator, so there is",
        'nothing to start without credentials. Create a test key and put these two lines',
        'in apps/frontend/client/.env.local (gitignored, and read by the dev server):',
        '',
        '  STRIPE_API_BASE=https://api.stripe.com',
        '  STRIPE_SECRET_KEY=sk_test_…          # https://dashboard.stripe.com/test/apikeys',
        '',
        'Then declare the catalogue in that account:  bun run stripe:setup -- --dry-run',
        '  For an offline alternative that needs no account, run a stripe-mock container',
        '  yourself and point STRIPE_API_BASE at it — it keeps no state, so most flows',
        '  will not survive the call that created them.',
      ].join('\n'),
    );
  }

  const problem = stripeTargetProblem(configured);
  if (problem !== null) {
    throw new Error(problem);
  }

  // Only a real Stripe account is worth proving. A self-hosted emulator is a
  // different machine with its own ideas about which keys it accepts, and refusing a
  // key it would happily take would be this service guessing on its behalf.
  if (isLocalStripeTarget(configured.apiBase)) {
    return {
      id: 'stripe',
      label: 'Stripe (local emulator)',
      owned: false,
      // The caller's own values are already the base of the run-owned vars file, so
      // echoing them back would be a service contesting its caller's binding.
      vars: {},
      summary: [
        `Stripe emulator (your own) -> ${configured.apiBase}`,
        ...STRIPE_MOCK_LIMITS.map((limit) => `  ${limit}`),
        ...webhookBridgeInstructions(
          context.origin,
          dependencies.bridgeStatus(context.environment),
        ),
      ],
      dispose: async () => [],
    };
  }

  // The work throws with the problem on the first line, because that is the line
  // the indicator shows, and the remedy underneath it for whoever reads the failure.
  await reportStep(
    context.progress,
    'checking the Stripe test credentials',
    async () => {
      const result = await dependencies.verify(configured);
      if (!result.ok) {
        throw new Error(`${result.problem}\n${result.remedy}`);
      }
      return result;
    },
    () => 'the key authenticates',
  );

  return {
    id: 'stripe',
    label: 'Stripe test mode',
    // Nothing was started, so nothing is torn down.
    owned: false,
    // As above: the caller's bindings are already in the run-owned file. Repeating
    // them here would look like two services writing one value.
    vars: {},
    summary: [
      `Stripe test mode -> ${configured.apiBase}`,
      '  Real objects, real webhooks, no money: every object created here exists in your',
      '  Stripe test account and is visible at https://dashboard.stripe.com/test.',
      ...webhookBridgeInstructions(context.origin, dependencies.bridgeStatus(context.environment)),
    ],
    dispose: async () => [],
  };
};
