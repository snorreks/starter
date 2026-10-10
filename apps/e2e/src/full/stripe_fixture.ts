// apps/e2e/src/full/stripe_fixture.ts
//
// Stripe, as a fixture that keeps state.
//
// `google_fixture.ts` answers the Cloud Run and OAuth endpoints the jobs Worker
// needs. This does the same for Stripe, and it is the piece that makes a billing
// assertion mean something: the fixture is seeded from `@starter/billing`, so a
// lookup key resolves to *the catalogue's amount*. A test can then assert what the
// application asked for, and separately what the account was charged, and those
// two being equal is a fact rather than a restatement of the application's own
// expectation.
//
// **Why not `stripe-mock` here.** stripe-mock holds no state and returns generated
// fixtures, so a lookup key resolves to whatever the generator produced and the
// assertion would be about the emulator. This fixture keeps what it was told, which
// is what makes "the app did not send an amount" observable: the amount in the
// recorded session came from the catalogue, and the request that produced it
// carried a lookup key.
//
// **It is a fixture, and it says so.** It implements the endpoints this
// application calls and no others. It does not model tax, proration, trials,
// invoices or dunning, and a test that needs those must say so rather than infer
// support from the presence of a checkout URL.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BILLING_CATALOG,
  type BillingInterval,
  type CreditPack,
  CURRENCY,
  type PlanId,
  planPriceLookupKey,
  purchasablePlans,
  resolveCreditPack,
  resolveSubscription,
} from '@starter/billing';
import { Response as MiniflareResponse, type V4FetchHandler } from 'miniflare';
import { runScope } from '../../../../scripts/src/shared/run_scope.ts';

/**
 * The fixture's signing secret, derived from the run id.
 *
 * Exported and used by both the fixture and the specs, because they are two
 * processes and have to agree. The circularity is between the test and the
 * fixture, never between the test and the application: the application reads this
 * value from a Worker binding the runtime host set, so a test that derived it
 * independently would still catch a binding that was never delivered.
 *
 * It is a fixture constant, not a credential. It is derived from a run id that is
 * already on disk and is worthless against anything real.
 */
export const stripeFixtureSecret = (runId: string): string =>
  `whsec_fixture_${runId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;

/** One recorded checkout, as the fixture received it. Read by assertions. */
export interface RecordedCheckout {
  readonly id: string;
  readonly mode: string;
  readonly customer: string;
  /** The `line_items[0][price]` the application sent — a lookup key, never a number. */
  readonly requestedPrice: string;
  /** What that lookup key resolved to in the catalogue, in minor units. */
  readonly resolvedAmount: number;
  readonly currency: string;
  readonly recurring: BillingInterval | null;
  readonly metadata: Record<string, string>;
  /** Whether the request carried any numeric amount at all. Must always be false. */
  readonly carriedAmount: boolean;
}

export interface StripeFixture {
  readonly outbound: V4FetchHandler;
  /** Every checkout the application opened, in order. */
  checkouts(): readonly RecordedCheckout[];
  /** The signing secret the webhook endpoint shares with this fixture. */
  readonly webhookSecret: string;
  /** Run-scoped JSONL of every checkout, readable by the specs. */
  readonly evidencePath: string;
  /** Deliver a correctly signed event to the application, as Stripe would. */
  deliver(type: string, object: Record<string, unknown>): Promise<Response>;
  readonly dispose: () => Promise<void>;
}

const json = (body: unknown, status = 200) =>
  new MiniflareResponse(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * The catalogue, indexed by the lookup key Stripe would use.
 *
 * Built once from `@starter/billing` so the fixture and the application resolve the
 * same prices by construction. An amount that is absent here is absent from the
 * catalogue, which is what makes "the app sent a lookup key, not a number" provable.
 */
const cataloguePrices = (): Map<string, { amount: number; recurring: BillingInterval | null }> => {
  const prices = new Map<string, { amount: number; recurring: BillingInterval | null }>();

  for (const plan of purchasablePlans()) {
    for (const interval of ['month', 'year'] as const) {
      const resolved = resolveSubscription(plan.planId, interval);
      if (resolved.ok) {
        prices.set(planPriceLookupKey(plan.planId as PlanId, interval), {
          amount: resolved.amount,
          recurring: interval,
        });
      }
    }
  }
  for (const pack of Object.values(BILLING_CATALOG.creditPacks) as readonly CreditPack[]) {
    const resolved = resolveCreditPack(pack.packId);
    if (resolved.ok) {
      prices.set(pack.packId, { amount: resolved.amount, recurring: null });
    }
  }
  return prices;
};

const formToRecord = (body: string): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    out[key] = [...(out[key] ?? []), value];
  }
  return out;
};

export const startStripeFixture = (options: {
  appOrigin: string;
  runId: string;
}): StripeFixture => {
  const prices = cataloguePrices();
  const recorded: RecordedCheckout[] = [];
  const endpoints: { id: string; url: string; enabled_events: string[] }[] = [];
  const webhookSecret = stripeFixtureSecret(options.runId);
  const evidenceDirectory = join(runScope(options.runId).artifactDir, 'stripe');
  const evidencePath = join(evidenceDirectory, 'checkouts.jsonl');
  let counter = 0;

  /**
   * Record every checkout to run-scoped evidence.
   *
   * The specs are a different process from this one and cannot call `checkouts()`,
   * so the observation of "what the account was actually asked for" reaches the test
   * the same way the encode lane's compute evidence does: through a file in the
   * run's own artifact directory. Written before the response is returned, so a
   * passing assertion can never read a file that does not yet describe its request.
   */
  const record = async (checkout: RecordedCheckout): Promise<void> => {
    recorded.push(checkout);
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    await appendFile(evidencePath, `${JSON.stringify(checkout)}\n`, { mode: 0o600 });
  };

  const outbound: V4FetchHandler = async (request) => {
    const url = new URL(request.url);
    // Anything that is not Stripe is somebody else's business; a fixture that
    // answered every host would silently swallow a misrouted request.
    if (url.hostname !== 'api.stripe.com' && !url.hostname.startsWith('127.0.0.1')) {
      return new MiniflareResponse('not a Stripe request', { status: 502 });
    }

    // ── Checkout ──────────────────────────────────────────────────────────
    if (url.pathname === '/v1/checkout/sessions' && request.method === 'POST') {
      const form = formToRecord(await request.text());
      const requestedPrice = form['line_items[0][price]']?.[0] ?? '';
      const price = prices.get(requestedPrice);

      // Stripe answers an unknown price with a 400 rather than inventing one. A
      // fixture that resolved anything would hide a lookup key the catalogue does
      // not define — which is the exact defect this lane exists to catch.
      if (price === undefined) {
        return json(
          { error: { message: `No such price: ${requestedPrice}`, type: 'invalid_request_error' } },
          400,
        );
      }

      counter += 1;
      const id = `cs_fixture_${counter}`;
      const metadata: Record<string, string> = {};
      for (const [key, values] of Object.entries(form)) {
        const match = /^metadata\[(.+)\]$/.exec(key);
        if (match) {
          metadata[match[1] as string] = values[0] ?? '';
        }
      }
      await record({
        id,
        mode: form.mode?.[0] ?? '',
        customer: form.customer?.[0] ?? '',
        requestedPrice,
        resolvedAmount: price.amount,
        currency: CURRENCY,
        recurring: price.recurring,
        metadata,
        // The load-bearing assertion: a `unit_amount` anywhere in a line item would
        // mean the application chose what it charges rather than naming a price.
        carriedAmount: Object.keys(form).some((key) => key.includes('unit_amount')),
      });

      return json({
        id,
        object: 'checkout.session',
        url: `${options.appOrigin}/billing?session=${id}`,
      });
    }

    // ── Catalogue, so `stripe:setup` has something to reconcile against ────
    if (url.pathname === '/v1/prices' && request.method === 'GET') {
      const keys = url.searchParams.getAll('lookup_keys[]');
      const data = [...prices.entries()]
        .filter(([key]) => keys.length === 0 || keys.includes(key))
        .map(([lookup_key, price]) => ({
          id: `price_${lookup_key}`,
          lookup_key,
          unit_amount: price.amount,
          currency: CURRENCY,
          active: true,
        }));
      return json({ data });
    }
    if (url.pathname === '/v1/products' && request.method === 'GET') {
      return json({ data: [] });
    }
    if (url.pathname === '/v1/webhook_endpoints' && request.method === 'GET') {
      return json({ data: endpoints });
    }

    return json({ error: { message: `unhandled ${request.method} ${url.pathname}` } }, 404);
  };

  const deliver = async (type: string, object: Record<string, unknown>): Promise<Response> => {
    counter += 1;
    const raw = JSON.stringify({ id: `evt_fixture_${counter}`, type, data: { object } });
    const timestamp = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const digest = [
      ...new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${raw}`)),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');

    return await fetch(`${options.appOrigin}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${digest}`,
      },
      body: raw,
    });
  };

  return {
    outbound,
    checkouts: () => recorded,
    webhookSecret,
    evidencePath,
    deliver,
    dispose: async () => {
      recorded.length = 0;
      endpoints.length = 0;
    },
  };
};
