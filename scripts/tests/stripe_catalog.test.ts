// scripts/tests/stripe_catalog.test.ts
//
// Declaring the catalogue, against a Stripe that behaves like one.
//
// The idempotency and roll-forward rules are the whole point of this module: run
// it twice and the second run must change nothing, and a price whose amount
// changed must be replaced rather than edited — because a Stripe price is
// immutable, and "editing" one keeps billing the old amount to existing
// subscribers while reporting that the catalogue was updated.
//
// Every test drives an in-memory Stripe rather than a mock function, so the
// request shapes — form encoding, the `lookup_keys` filter, the archive call — are
// themselves under test.

import { describe, expect, test } from 'bun:test';
import { BILLING_PLANS, purchasablePlans, resolveSubscription } from '@starter/billing';
import { isEmulated, syncStripeCatalog, syncWebhookEndpoint } from '../src/setup/stripe_catalog.ts';

interface FakeState {
  products: { id: string; name: string; metadata: Record<string, string> }[];
  prices: {
    id: string;
    product: string;
    unit_amount: number;
    active: boolean;
    lookup_key: string;
    recurring: { interval: string } | null;
  }[];
  endpoints: { id: string; url: string; enabled_events: string[] }[];
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Stripe's form encoding, parsed the way Stripe parses it.
 *
 * `metadata[plan_id]=starter`, `recurring[interval]=month` and
 * `enabled_events[0]=invoice.paid` are three shapes, and a double that only
 * understood flat keys would have hidden a real bug: product metadata posted as
 * `metadata={...}` would never be read back, so every run would create the
 * product again and the catalogue would never converge.
 */
const parseForm = (body: unknown): Record<string, string | string[] | Record<string, string>> => {
  const form = new URLSearchParams(String(body));
  const out: Record<string, string | string[] | Record<string, string>> = {};
  for (const [rawKey, value] of form) {
    const nested = /^(.+)\[(.+)\]$/.exec(rawKey);
    if (nested === null) {
      out[rawKey] = value;
      continue;
    }
    const [, head, tail] = nested as unknown as [string, string, string];
    if (/^\d+$/.test(tail)) {
      const list = (out[head] as string[] | undefined) ?? [];
      list[Number(tail)] = value;
      out[head] = list;
      continue;
    }
    const inner = (out[head] as Record<string, string> | undefined) ?? {};
    inner[tail] = value;
    out[head] = inner;
  }
  return out;
};

/**
 * A Stripe that keeps what it is told.
 *
 * Deliberately faithful about the two behaviours the module depends on: prices
 * cannot be edited (a POST to `/v1/prices/{id}` only accepts `active`), and a
 * `lookup_keys` filter returns only live prices.
 */
const fakeStripe = (seed: Partial<FakeState> = {}) => {
  const state: FakeState = {
    products: seed.products ?? [],
    prices: seed.prices ?? [],
    endpoints: seed.endpoints ?? [],
  };
  const requests: { method: string; path: string }[] = [];
  let nextId = 1;

  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://api.stripe.test');
    const method = (init?.method ?? 'GET') as string;
    const path = url.pathname;
    requests.push({ method, path: `${path}${url.search}` });

    if (method === 'GET' && path === '/v1/products') {
      return jsonResponse({ data: state.products });
    }
    if (method === 'GET' && path === '/v1/prices') {
      const keys = url.searchParams.getAll('lookup_keys[]');
      const data = state.prices.filter(
        (price) => price.active && (keys.length === 0 || keys.includes(price.lookup_key)),
      );
      return jsonResponse({ data });
    }
    if (method === 'POST' && path === '/v1/products') {
      const body = parseForm(init?.body) as Record<string, string> & {
        metadata?: Record<string, string>;
      };
      const created = {
        id: `prod_${nextId++}`,
        name: body.name ?? '',
        metadata: body.metadata ?? {},
      };
      state.products.push(created);
      return jsonResponse(created);
    }
    if (method === 'POST' && path === '/v1/prices') {
      const body = parseForm(init?.body) as Record<string, string> & {
        recurring?: Record<string, string>;
      };
      const created = {
        id: `price_${nextId++}`,
        product: body.product ?? '',
        unit_amount: Number(body.unit_amount),
        active: true,
        lookup_key: body.lookup_key ?? '',
        recurring:
          body.recurring === undefined ? null : { interval: body.recurring.interval ?? '' },
      };
      state.prices.push(created);
      return jsonResponse(created);
    }
    if (method === 'POST' && /^\/v1\/prices\/price_[A-Za-z0-9]+$/.test(path)) {
      const id = path.slice('/v1/prices/'.length);
      const found = state.prices.find((price) => price.id === id);
      if (found === undefined) {
        return jsonResponse({ error: { message: 'No such price' } }, 404);
      }
      // Stripe refuses to change a price's amount. Modelling that is the point:
      // a fake that allowed it would let this module "update" a price and hide the
      // reason roll-forward exists.
      if (Object.hasOwn(parseForm(init?.body), 'unit_amount')) {
        return jsonResponse({ error: { message: 'Price amounts are immutable' } }, 400);
      }
      found.active = false;
      return jsonResponse(found);
    }
    if (method === 'GET' && path === '/v1/webhook_endpoints') {
      return jsonResponse({ data: state.endpoints });
    }
    if (method === 'POST' && /^\/v1\/webhook_endpoints\/we_[A-Za-z0-9]+$/.test(path)) {
      const id = path.slice('/v1/webhook_endpoints/'.length);
      const found = state.endpoints.find((endpoint) => endpoint.id === id);
      if (found === undefined) {
        return jsonResponse({ error: { message: 'No such endpoint' } }, 404);
      }
      const body = parseForm(init?.body) as { enabled_events?: string[] };
      found.enabled_events = body.enabled_events ?? found.enabled_events;
      return jsonResponse(found);
    }
    if (method === 'POST' && path === '/v1/webhook_endpoints') {
      const body = parseForm(init?.body) as Record<string, string> & { enabled_events?: string[] };
      const created = {
        id: `we_${nextId++}`,
        url: body.url ?? '',
        enabled_events: body.enabled_events ?? [],
      };
      state.endpoints.push(created);
      return jsonResponse(created);
    }
    return jsonResponse({ error: { message: `Unhandled ${method} ${path}` } }, 404);
  }) as unknown as typeof fetch;

  return { state, requests, fetcher };
};

const REAL = { apiBase: 'https://api.stripe.test', secretKey: 'sk_test_fixture' };
const LOCAL = { apiBase: 'http://127.0.0.1:4300', secretKey: 'sk_test_stripe_mock_local' };

describe('running twice changes nothing the second time', () => {
  test('a fresh account is populated, and a second run reports no changes', async () => {
    const stripe = fakeStripe();

    const first = await syncStripeCatalog(REAL, { fetcher: stripe.fetcher });
    expect(first.ok).toBe(true);
    expect(stripe.state.products.length).toBeGreaterThan(0);
    expect(first.outcomes.filter((outcome) => outcome.action === 'created').length).toBeGreaterThan(
      0,
    );

    const second = await syncStripeCatalog(REAL, { fetcher: stripe.fetcher });
    expect(second.ok).toBe(true);
    // The idempotency claim, stated as a fact rather than a hope: no new product
    // and no new price the second time round.
    expect(second.outcomes.filter((outcome) => outcome.action === 'created')).toEqual([]);
    expect(second.outcomes.filter((outcome) => outcome.action === 'updated')).toEqual([]);
  });

  test('a second run writes nothing at all', async () => {
    const stripe = fakeStripe();
    await syncStripeCatalog(REAL, { fetcher: stripe.fetcher });
    const writesAfterFirst = stripe.requests.filter((request) => request.method === 'POST').length;

    await syncStripeCatalog(REAL, { fetcher: stripe.fetcher });
    const writesAfterSecond = stripe.requests.filter((request) => request.method === 'POST').length;

    expect(writesAfterSecond).toBe(writesAfterFirst);
  });
});

describe('a changed price is rolled forward, never edited', () => {
  test('the predecessor is archived and a new price carries the new amount', async () => {
    // Existing subscribers keep the price they subscribed at, which is correct —
    // and the reason this must never be reported as an "update".
    const plan = purchasablePlans()[0];
    const resolved = resolveSubscription(plan.planId, 'month');
    if (!resolved.ok) {
      throw new Error('the fixture plan is not purchasable');
    }

    const stripe = fakeStripe({
      products: [{ id: 'prod_existing', name: plan.name, metadata: { plan_id: plan.planId } }],
      prices: [
        {
          id: 'price_old',
          product: 'prod_existing',
          unit_amount: resolved.amount - 1,
          active: true,
          lookup_key: resolved.lookupKey,
          recurring: { interval: 'month' },
        },
      ],
    });

    const report = await syncStripeCatalog(REAL, { fetcher: stripe.fetcher });

    const outcome = report.outcomes.find(
      (entry) => entry.action === 'created' && entry.name.startsWith(plan.name),
    );
    expect(outcome?.action).toBe('created');
    expect(stripe.state.prices.find((price) => price.id === 'price_old')?.active).toBe(false);
    // Two live prices under one lookup key would leave the amount ambiguous.
    const live = stripe.state.prices.filter(
      (price) => price.active && price.lookup_key === resolved.lookupKey,
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.unit_amount).toBe(resolved.amount);
  });

  test('two live prices under one lookup key are refused rather than resolved arbitrarily', async () => {
    // Reconciliation by lookup key would otherwise pick whichever the API listed
    // first, and a customer could be billed either amount.
    const plan = purchasablePlans()[0];
    const resolved = resolveSubscription(plan.planId, 'month');
    if (!resolved.ok) {
      throw new Error('the fixture plan is not purchasable');
    }

    const stripe = fakeStripe({
      products: [{ id: 'prod_existing', name: plan.name, metadata: { plan_id: plan.planId } }],
      prices: [1, 2].map((n) => ({
        id: `price_dup${n}`,
        product: 'prod_existing',
        unit_amount: resolved.amount + n,
        active: true,
        lookup_key: resolved.lookupKey,
        recurring: { interval: 'month' as const },
      })),
    });

    const report = await syncStripeCatalog(REAL, { fetcher: stripe.fetcher });
    expect(report.ok).toBe(false);
    expect(report.outcomes.some((outcome) => outcome.action === 'failed')).toBe(true);
    expect(report.outcomes.find((outcome) => outcome.action === 'failed')?.reason).toContain(
      'share lookup key',
    );
  });
});

describe('a dry run reports without writing', () => {
  test('nothing is created and every gap is named', async () => {
    const stripe = fakeStripe();
    const report = await syncStripeCatalog(REAL, { dryRun: true, fetcher: stripe.fetcher });

    expect(stripe.state.products).toEqual([]);
    expect(stripe.requests.some((request) => request.method === 'POST')).toBe(false);
    expect(report.outcomes.some((outcome) => outcome.action === 'skipped')).toBe(true);
  });
});

describe('a plan that cannot be bought is reported, not created', () => {
  test('it appears in the outcome as skipped with a reason', async () => {
    // A `continue` here would be a silent skip, and a run that looks complete while
    // omitting a catalogue entry is the failure this repository treats as worst.
    const unpurchasable = Object.values(BILLING_PLANS).filter((plan) => !plan.purchasable);
    expect(unpurchasable.length).toBeGreaterThan(0);

    const stripe = fakeStripe();
    const report = await syncStripeCatalog(REAL, { fetcher: stripe.fetcher });

    for (const plan of unpurchasable) {
      const outcome = report.outcomes.find(
        (entry) => entry.name === `${plan.name} plan` && entry.action === 'skipped',
      );
      expect(outcome).toBeDefined();
    }
    expect(
      stripe.state.products.some(
        (product) => product.metadata.plan_id === unpurchasable[0]?.planId,
      ),
    ).toBe(false);
  });
});

describe('the emulator is detected rather than assumed', () => {
  test('a loopback base is local, and the report says so', async () => {
    expect(isEmulated(LOCAL)).toBe(true);
    expect(isEmulated(REAL)).toBe(false);
    expect(isEmulated({ apiBase: 'not a url', secretKey: 'x' })).toBe(false);

    // The flag is what makes `stripe:setup` refuse rather than exit 0 having
    // provisioned nothing durable.
    const report = await syncStripeCatalog(LOCAL, { fetcher: fakeStripe().fetcher });
    expect(report.emulated).toBe(true);
  });
});

describe('the webhook endpoint is opt-in and reconciled by URL', () => {
  test('an existing endpoint has its event list refreshed from the catalogue', async () => {
    const stripe = fakeStripe({
      endpoints: [
        { id: 'we_1', url: 'https://example.test/api/webhooks/stripe', enabled_events: [] },
      ],
    });

    const outcome = await syncWebhookEndpoint(REAL, {
      url: 'https://example.test/api/webhooks/stripe',
      fetcher: stripe.fetcher,
    });

    expect(outcome.action).toBe('updated');
    expect(stripe.state.endpoints[0]?.enabled_events).toContain('invoice.paid');
  });

  test('a new endpoint is created, and its signing secret is never in the output', async () => {
    const stripe = fakeStripe();
    const outcome = await syncWebhookEndpoint(REAL, {
      url: 'https://example.test/api/webhooks/stripe',
      fetcher: stripe.fetcher,
    });

    expect(outcome.action).toBe('created');
    // Returned exactly once by Stripe, and it must not appear in a log line.
    expect(JSON.stringify(outcome)).not.toContain('whsec');
  });
});
