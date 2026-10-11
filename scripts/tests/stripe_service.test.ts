// scripts/tests/stripe_service.test.ts
//
// The Stripe service. It starts nothing, so every assertion here is about a
// *refusal* or about what the developer is told — which is the entire content of
// the service now that the emulator is gone.
//
// The failures being prevented:
//   * a development stack that accepts a live-mode key and creates real invoices
//   * a `--stack stripe` that reports success with no Stripe configured
//   * a credential check that disagrees with what the dev server would actually load
//   * webhook delivery described as available when `stripe listen` would forward nothing

import { describe, expect, test } from 'bun:test';
import type { LocalServiceContext } from '../src/local/service.ts';
import { LocalServiceUnavailable } from '../src/local/service.ts';
import {
  developerStripeConfig,
  isLocalStripeTarget,
  parseDotenv,
  prepareStripeService,
  STRIPE_API_BASE_DEFAULT,
  STRIPE_MOCK_LIMITS,
  type StripeBridgeStatus,
  type StripeServiceDependencies,
  stripeBridgeStatus,
  stripeKeyMode,
  stripeTargetProblem,
  verifyStripeCredentials,
  webhookBridgeInstructions,
} from '../src/local/stripe_service.ts';
import { recordingProgress } from './fixtures/progress.ts';

const context = (overrides: Partial<LocalServiceContext> = {}): LocalServiceContext => ({
  runId: 'dev_test',
  scope: {
    runId: 'dev_test',
    dir: '/owned/run',
    stateDir: '/owned/run/state',
    logDir: '/owned/run/logs',
    artifactDir: '/owned/run/artifacts',
  },
  origin: 'http://127.0.0.1:5173',
  callerVars: {},
  environment: {},
  progress: recordingProgress().progress,
  ...overrides,
});

const TEST_KEY = 'sk_test_51Hxxxxxx';

const NO_BRIDGE: StripeBridgeStatus = {
  available: false,
  reason: 'The Stripe CLI is not on PATH.',
  remedy: 'Install it.',
};

const dependencies = (
  overrides: Partial<StripeServiceDependencies> = {},
): Partial<StripeServiceDependencies> => ({
  configure: () => ({ apiBase: STRIPE_API_BASE_DEFAULT, secretKey: TEST_KEY }),
  verify: async () => ({ ok: true }),
  bridgeStatus: () => NO_BRIDGE,
  ...overrides,
});

describe('a live-mode key is refused before anything else is judged', () => {
  test('a live secret key names itself and says what to use instead', () => {
    // The failure this prevents: a local development stack pointed at live mode,
    // where one click on a checkout button creates a real subscription and a real
    // invoice. There is no override — Stripe's test mode is a complete environment.
    const problem = stripeTargetProblem({
      apiBase: STRIPE_API_BASE_DEFAULT,
      secretKey: 'sk_live_51Hxxxxxx',
    });
    expect(problem).toContain('sk_live_');
    expect(problem).toContain('Refusing');
    expect(problem).toContain('sk_test_');
  });

  test('a restricted key is refused for a different, stated reason', () => {
    // `rk_` keys cannot sign SDK requests at all, so the failure would otherwise
    // surface as an opaque 401 at the checkout button rather than here.
    const problem = stripeTargetProblem({
      apiBase: STRIPE_API_BASE_DEFAULT,
      secretKey: 'rk_test_51Hxxxxxx',
    });
    expect(problem).toContain('rk_');
    expect(problem).toContain('cannot');
  });

  test('an unrecognised key is refused rather than tried', () => {
    // A typo, or a publishable key pasted where the secret goes. Guessing would
    // mean a request to Stripe with something that should never have left the box.
    for (const key of ['pk_test_51H', 'nonsense', '']) {
      expect(stripeTargetProblem({ apiBase: STRIPE_API_BASE_DEFAULT, secretKey: key })).toContain(
        'sk_test_',
      );
    }
  });

  test('a secret key sent over plaintext is refused', () => {
    const problem = stripeTargetProblem({
      apiBase: 'http://api.stripe.example.com',
      secretKey: TEST_KEY,
    });
    expect(problem).toContain('HTTPS');
  });

  test('a test key against Stripe is accepted', () => {
    expect(
      stripeTargetProblem({ apiBase: STRIPE_API_BASE_DEFAULT, secretKey: TEST_KEY }),
    ).toBeNull();
  });

  test('the mode of a key is read from its prefix', () => {
    expect(stripeKeyMode('sk_test_1')).toBe('test');
    expect(stripeKeyMode('sk_live_1')).toBe('live');
    expect(stripeKeyMode('rk_test_1')).toBe('restricted');
    expect(stripeKeyMode('whsec_1')).toBe('unknown');
  });
});

describe('the configuration is read from where the dev server reads it', () => {
  // Keyed by file name, because the real paths are absolute and machine-specific.
  const read = (files: Record<string, Record<string, string>>) => (path: string) => {
    const name = path.split('/').pop() ?? path;
    return files[name] ?? {};
  };

  test('a key in .env.local is found, which is where a developer puts one', () => {
    // The service used to look only at the environment and the run-owned vars file.
    // A developer who put their key in `.env.local` — the obvious place, and one vite
    // loads — would have been refused by a check the app itself disagreed with.
    const found = developerStripeConfig(
      {},
      read({ '.env.local': { STRIPE_SECRET_KEY: TEST_KEY } }),
    );
    expect(found).toEqual({ apiBase: STRIPE_API_BASE_DEFAULT, secretKey: TEST_KEY });
  });

  test("the caller's own configuration beats a dotenv file", () => {
    // `.env.local` is a default; a configured binding is a decision, and the run-owned
    // vars file is what a lane sets deliberately.
    const found = developerStripeConfig(
      { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_API_BASE: 'https://api.stripe.example.com' },
      read({
        '.env.local': { STRIPE_SECRET_KEY: 'sk_test_dotenv', STRIPE_API_BASE: 'https://old' },
      }),
    );
    expect(found?.secretKey).toBe(TEST_KEY);
    expect(found?.apiBase).toBe('https://api.stripe.example.com');
  });

  test('.env.local beats .env, matching the order vite loads them', () => {
    const found = developerStripeConfig(
      {},
      read({
        '.env': { STRIPE_SECRET_KEY: 'sk_test_base' },
        '.env.local': { STRIPE_SECRET_KEY: TEST_KEY },
      }),
    );
    expect(found?.secretKey).toBe(TEST_KEY);
  });

  test('no key anywhere is reported as no configuration, not as a broken one', () => {
    expect(developerStripeConfig({}, read({}))).toBeNull();
  });

  test('dotenv quoting and comments do not end up inside the key', () => {
    // A stray quote in a dotenv file is the kind of thing that turns a working key
    // into an opaque 401 at the checkout button, an hour later.
    expect(parseDotenv('# a comment\nSTRIPE_SECRET_KEY="sk_test_x"\n')).toEqual({
      STRIPE_SECRET_KEY: 'sk_test_x',
    });
    expect(parseDotenv("export FOO='bar'\n")).toEqual({ FOO: 'bar' });
    expect(parseDotenv('NO_EQUALS_HERE\n')).toEqual({});
    expect(parseDotenv('KEY=sk_test_x # dashboard link\nEMPTY=# comment')).toEqual({
      KEY: 'sk_test_x',
      EMPTY: '',
    });
    expect(parseDotenv(`DOUBLE="value # text"\nSINGLE='value#text'`)).toEqual({
      DOUBLE: 'value # text',
      SINGLE: 'value#text',
    });
  });

  test('a loopback base URL is recognised as local, not as Stripe', () => {
    expect(isLocalStripeTarget('http://127.0.0.1:12111')).toBe(true);
    expect(isLocalStripeTarget(STRIPE_API_BASE_DEFAULT)).toBe(false);
  });
});

describe('credentials are proved before the developer needs them', () => {
  test('a 401 says the key was rejected and does not suggest retrying', async () => {
    const result = await verifyStripeCredentials(
      { apiBase: STRIPE_API_BASE_DEFAULT, secretKey: TEST_KEY },
      { fetch: async () => new Response('', { status: 401 }) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('a rejected key reported success');
    }
    expect(result.problem).toContain('401');
    expect(result.remedy).toContain('test/apikeys');
  });

  test('an unreachable Stripe is named as a network problem, not a bad key', async () => {
    // These have opposite fixes. Reporting one as the other sends the developer to
    // rotate a key that is fine.
    const result = await verifyStripeCredentials(
      { apiBase: STRIPE_API_BASE_DEFAULT, secretKey: TEST_KEY },
      {
        fetch: async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('an unreachable Stripe reported success');
    }
    expect(result.problem).toContain('ENOTFOUND');
    expect(result.remedy).toContain('network');
  });

  test('the key travels in a header, never in the URL', async () => {
    let seen = '';
    await verifyStripeCredentials(
      { apiBase: STRIPE_API_BASE_DEFAULT, secretKey: TEST_KEY },
      {
        fetch: async (input) => {
          seen = String(input);
          return new Response('{}', { status: 200 });
        },
      },
    );
    expect(seen).not.toContain(TEST_KEY);
    expect(seen).toContain('/v1/products');
  });

  test('a rejected key fails the run, and says which part was wrong', async () => {
    // A `--stack stripe` that starts and then 503s every checkout has wasted the
    // developer in the least recoverable way.
    await expect(
      prepareStripeService(
        context(),
        dependencies({
          verify: async () => ({
            ok: false,
            problem: 'Stripe rejected the key (401).',
            remedy: 'Check it.',
          }),
        }),
      ),
    ).rejects.toThrow('Stripe rejected the key (401).');
  });

  test('a working key is reported as working', async () => {
    const service = await prepareStripeService(context(), dependencies());
    expect(service.summary.join('\n')).toContain(STRIPE_API_BASE_DEFAULT);
    expect(service.label).toBe('Stripe test mode');
  });
});

describe('the stack refuses rather than running without Stripe', () => {
  test('no key is an unavailability naming the key and where to get it', async () => {
    // The zero-credential fallback went away with the emulator. What is left is a
    // refusal, and it has to carry the remedy — a `--stack stripe` that exits with
    // "unavailable" and no instructions is the outcome this repository treats as
    // worse than an error. The remedy is a separate field from the message, and both
    // are printed by the caller, so both are asserted.
    let caught: unknown;
    try {
      await prepareStripeService(context(), dependencies({ configure: () => null }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LocalServiceUnavailable);
    const refusal = caught as LocalServiceUnavailable;
    expect(refusal.service).toBe('stripe');
    expect(refusal.prerequisite).toContain('test secret key');
    expect(refusal.remedy).toContain('.env.local');
    expect(refusal.remedy).toContain('sk_test_');
    // The offline alternative is named too: "no credentials" is not the only way to
    // want Stripe locally, and the emulator still exists.
    expect(refusal.remedy).toContain('stripe-mock');
  });

  test('the service contributes validated credentials without owning a process', async () => {
    const service = await prepareStripeService(context(), dependencies());
    expect(service.owned).toBe(false);
    expect(service.vars).toEqual({
      STRIPE_API_BASE: STRIPE_API_BASE_DEFAULT,
      STRIPE_SECRET_KEY: TEST_KEY,
    });
    expect(await service.dispose()).toEqual([]);
  });
});

test('caller-owned Stripe bindings are preserved while missing bindings are contributed', async () => {
  const callerVars = { STRIPE_SECRET_KEY: TEST_KEY };
  const service = await prepareStripeService(
    context({ callerVars }),
    dependencies({ configure: (vars) => developerStripeConfig(vars, () => ({})) }),
  );
  expect(service.vars).toEqual({ STRIPE_API_BASE: STRIPE_API_BASE_DEFAULT });
  expect(callerVars).toEqual({ STRIPE_SECRET_KEY: TEST_KEY });
});

describe('a self-hosted emulator is still allowed, and still says what it costs', async () => {
  test('a loopback target skips the credential check and prints the limits', async () => {
    // Removing stripe-mock from the stack did not make it stop existing: a
    // developer can still run one. The check that would prove the key is refused for
    // a target that may well accept a placeholder, and the limits are printed
    // because that target is stateless.
    let verified = false;
    const service = await prepareStripeService(
      context(),
      dependencies({
        configure: () => ({ apiBase: 'http://127.0.0.1:12111', secretKey: TEST_KEY }),
        verify: async () => {
          verified = true;
          return { ok: true };
        },
      }),
    );
    expect(verified).toBe(false);
    expect(service.vars).toEqual({
      STRIPE_API_BASE: 'http://127.0.0.1:12111',
      STRIPE_SECRET_KEY: TEST_KEY,
    });
    for (const limit of STRIPE_MOCK_LIMITS) {
      expect(service.summary.join('\n')).toContain(limit);
    }
  });
});

describe('webhook delivery is described by what is actually true', () => {
  const origin = 'http://127.0.0.1:5173';

  test('an installed, authenticated CLI gets the exact forwarding command', () => {
    const lines = webhookBridgeInstructions(origin, { available: true, command: 'stripe' }).join(
      '\n',
    );
    expect(lines).toContain(`stripe listen --forward-to ${origin}/api/webhooks/stripe`);
    // The secret has to go somewhere, and the endpoint refuses without it. Saying
    // where is the difference between a working bridge and an afternoon.
    expect(lines).toContain('STRIPE_WEBHOOK_SECRET');
    expect(lines).toContain('stripe trigger');
  });

  test('a missing CLI says delivery was NOT RUN, rather than omitting it', () => {
    const lines = webhookBridgeInstructions(origin, NO_BRIDGE).join('\n');
    expect(lines).toContain('NOT RUN');
    expect(lines).not.toContain('listen --forward-to');
  });

  test('an installed but unauthenticated CLI is called out separately', () => {
    // `stripe version` succeeds without a login, so a naive probe says ready and
    // `stripe listen` forwards nothing. This is the case worth three states.
    const status = stripeBridgeStatus({}, (command, args) => {
      if (args[0] === 'config') {
        return 1;
      }
      return command === 'stripe' ? 0 : null;
    });
    expect(status.available).toBe(false);
    if (status.available) {
      throw new Error('an unauthenticated CLI reported available');
    }
    expect(status.reason).toContain('not authenticated');
  });

  test('an absent CLI names the install', () => {
    const status = stripeBridgeStatus({}, () => null);
    expect(status.available).toBe(false);
    if (status.available) {
      throw new Error('an absent CLI reported available');
    }
    expect(status.remedy).toContain('stripe-cli');
  });

  test('an authenticated CLI is reported ready, and the override path is honoured', () => {
    const ready = stripeBridgeStatus({}, () => 0);
    expect(ready).toEqual({ available: true, command: 'stripe' });

    // `STRIPE_CLI_BIN` is how a developer points at a Homebrew or mise install this
    // probe cannot find on PATH.
    const overridden = stripeBridgeStatus({ STRIPE_CLI_BIN: '/opt/homebrew/bin/stripe' }, () => 0);
    expect(overridden).toEqual({ available: true, command: '/opt/homebrew/bin/stripe' });

    // A configured path that does not run is reported, not assumed.
    expect(stripeBridgeStatus({ STRIPE_CLI_BIN: '/nope/stripe' }, () => null).available).toBe(
      false,
    );
  });
});
