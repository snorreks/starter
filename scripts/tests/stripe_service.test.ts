// scripts/tests/stripe_service.test.ts
//
// The Stripe emulator service. Two things are load-bearing and both are asserted
// here: a caller who already configured Stripe is never silently given an emulator,
// and the emulator's missing capabilities are stated rather than discovered.

import { describe, expect, test } from 'bun:test';
import type { LocalServiceContext } from '../src/local/service.ts';
import {
  callerStripeValues,
  prepareStripeService,
  STRIPE_MOCK_LIMITS,
  type StripeServiceDependencies,
  stripeBridgeStatus,
} from '../src/local/stripe_service.ts';

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
  ...overrides,
});

/** A service whose engine, ports and containers are all observable without Docker. */
const recorder = () => {
  const calls: string[] = [];
  const removed: string[] = [];
  let readyFail: string | undefined;
  const dependencies: Partial<StripeServiceDependencies> = {
    resolveRuntime: (() => ({ command: 'podman', version: 'podman 5.0' })) as never,
    allocatePort: (async (_purpose: string) => ({
      port: 4300 + calls.length,
      rejected: [],
    })) as never,
    isPortBusy: (async () => false) as never,
    runContainer: async (engine, args) => {
      calls.push(`run:${engine}:${args[args.length - 1] ?? ''}`);
      return 'container-abc';
    },
    removeContainer: async (_engine, name) => {
      removed.push(name);
    },
    waitForHttp: async () => {
      if (readyFail !== undefined) {
        throw new Error(readyFail);
      }
      calls.push('ready');
    },
    bridgeStatus: () => ({ available: true, command: 'stripe' }),
  };
  return {
    calls,
    removed,
    dependencies,
    refuseReady: (message: string) => {
      readyFail = message;
    },
  };
};

describe('a caller who configured Stripe keeps it', () => {
  test('both halves are required before an emulator is considered', () => {
    // A base URL with no key means the SDK is pointed at a real account through
    // its default host. Starting an emulator underneath that would bill a live
    // test account through a stack the developer believes is local.
    expect(callerStripeValues({})).toBeNull();
    expect(callerStripeValues({ STRIPE_API_BASE: 'https://api.stripe.com' })).toBeNull();
    expect(callerStripeValues({ STRIPE_SECRET_KEY: 'sk_test_1' })).toBeNull();
    expect(callerStripeValues({ STRIPE_API_BASE: ' ', STRIPE_SECRET_KEY: 'sk_test_1' })).toBeNull();
    expect(
      callerStripeValues({
        STRIPE_API_BASE: 'https://api.stripe.com',
        STRIPE_SECRET_KEY: 'sk_test_1',
      }),
    ).toEqual({ apiBase: 'https://api.stripe.com', secretKey: 'sk_test_1' });
  });

  test('no container engine is touched when the configuration is complete', async () => {
    const rec = recorder();
    const service = await prepareStripeService(
      context({
        callerVars: { STRIPE_API_BASE: 'https://api.stripe.com', STRIPE_SECRET_KEY: 'sk_test_1' },
      }),
      rec.dependencies,
    );

    expect(service.owned).toBe(false);
    expect(service.vars.STRIPE_API_BASE).toBe('https://api.stripe.com');
    expect(rec.calls).toEqual([]);
    // Nothing was started, so nothing may be stopped: tearing down a developer's
    // own Stripe configuration on the way out would be indefensible.
    expect(await service.dispose()).toEqual([]);
  });
});

describe('the emulator starts, is verified, and cleans up after itself', () => {
  test('a successful start reports what the emulator cannot do', async () => {
    const rec = recorder();
    const service = await prepareStripeService(context(), rec.dependencies);

    expect(service.owned).toBe(true);
    expect(service.vars.STRIPE_API_BASE).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(rec.calls).toContain('ready');

    // The two facts that otherwise cost an afternoon each.
    const banner = service.summary.join('\n');
    for (const limit of STRIPE_MOCK_LIMITS) {
      expect(banner).toContain(limit);
    }
  });

  test('a service that never becomes ready is removed, not left holding its port', async () => {
    const rec = recorder();
    rec.refuseReady('connection refused');

    await expect(prepareStripeService(context(), rec.dependencies)).rejects.toThrow(
      'connection refused',
    );
    // Leaving it would mean the next run's probe fails on a port this run bound.
    expect(rec.removed).toHaveLength(1);
  });

  test('teardown names a container that survived removal', async () => {
    const rec = recorder();
    const service = await prepareStripeService(context(), {
      ...rec.dependencies,
      // `rm --force` reported success and the port is still bound. Reporting
      // nothing here means the next run fails on a bind error nobody can trace.
      isPortBusy: (async () => true) as never,
    });

    const failures = await service.dispose();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('still bound');
  });
});

describe('the webhook bridge is a separate question from the emulator', () => {
  // Answers by argv, not by binary name: that is what the probe branches on.
  const stub =
    (answers: Record<string, number>) =>
    (_command: string, args: readonly string[]): number | null =>
      answers[args.join(' ')] ?? null;

  test('absent, unauthenticated and ready are three different answers', () => {
    // `stripe version` succeeds without a login, so a green probe is not evidence
    // that `stripe listen` will forward anything. Collapsing the middle case into
    // "available" is how an afternoon disappears.
    // `{}` means the binary does not run at all: no probe answers.
    expect(stripeBridgeStatus({}, stub({}))).toMatchObject({
      available: false,
      reason: expect.stringContaining('not on PATH'),
    });

    expect(stripeBridgeStatus({}, stub({ version: 0, 'config --list': 1 }))).toMatchObject({
      available: false,
      reason: expect.stringContaining('not authenticated'),
    });

    expect(stripeBridgeStatus({}, stub({ version: 0, 'config --list': 0 }))).toEqual({
      available: true,
      command: 'stripe',
    });
  });

  test('an explicit STRIPE_CLI_BIN that does not run is reported, not silently replaced', () => {
    // Falling back to whatever is on PATH would ignore a developer pointing at a
    // specific installation — a Homebrew path, a mise shim.
    expect(stripeBridgeStatus({ STRIPE_CLI_BIN: '/opt/stripe' }, () => null)).toMatchObject({
      available: false,
      reason: expect.stringContaining('/opt/stripe'),
    });
  });

  test('every unavailable answer carries a remedy', () => {
    for (const answers of [{} as Record<string, number>, { version: 0, 'config --list': 1 }]) {
      const status = stripeBridgeStatus({}, stub(answers));
      expect(status.available).toBe(false);
      if (!status.available) {
        expect(status.remedy.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('a host without a container engine is a named failure', () => {
  test('the refusal names the engine and what to install', async () => {
    await expect(
      prepareStripeService(context(), {
        resolveRuntime: (() => null) as never,
      }),
    ).rejects.toThrow(/container engine/);
  });
});
