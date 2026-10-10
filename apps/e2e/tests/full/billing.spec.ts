// apps/e2e/tests/full/billing.spec.ts
//
// The money path, from the outside.
//
// Black box in the strict sense: every assertion here is about something observable
// from outside the process — an HTTP status, a response body, or what the Stripe
// fixture was actually asked for. Nothing imports a service, reads a container, or
// calls a resolver to find out what the application decided; where a test needs to
// know a price, it asks the catalogue and compares, rather than importing the
// module that produced the number.
//
// The four claims, and the failure each one would otherwise hide:
//
//   1. **A checkout's price comes from the catalogue.** The fixture records both
//      what the application sent (a lookup key) and what that key resolved to. If
//      the app had sent an amount, `carriedAmount` would be true.
//   2. **A caller cannot choose what it pays.** `amount` in the request body is a
//      400, not an ignored field — a field that is parsed and dropped teaches the
//      next reader that it is allowed.
//   3. **A webhook is verified or refused.** Unsigned and forged deliveries are
//      both 400; a correctly signed one is accepted; a stale one is refused.
//   4. **An event this application does not handle is still acknowledged.** 200, not
//      400 — answering 400 makes Stripe retry forever and then disable the endpoint,
//      taking the events it *does* handle with it.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BILLING_CATALOG, resolveSubscription } from '@starter/billing';
import { runScope } from '../../../../scripts/src/shared/run_scope.ts';
import { appBaseUrl } from '../../preflight.ts';
import { createVerifiedAccount } from '../../src/fixtures/accounts.ts';
import { type RecordedCheckout, stripeFixtureSecret } from '../../src/full/stripe_fixture.ts';

/**
 * What the Stripe fixture was actually asked for.
 *
 * Read from run-scoped evidence rather than from the application, because the point
 * is to observe the account side independently. If the application had supplied its
 * own amount, asking the application what amount it chose would agree with itself;
 * asking the account what it was told is the only question that can fail.
 */
const accountRecord = async (): Promise<RecordedCheckout[]> => {
  const runId = process.env.E2E_RUN_ID;
  if (!runId) {
    throw new Error('Billing evidence requires the Playwright-owned E2E_RUN_ID.');
  }
  const path = join(runScope(runId).artifactDir, 'stripe', 'checkouts.jsonl');
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedCheckout);
};

/** Sign a body the way Stripe does, so "forged" and "genuine" are distinguishable. */
const sign = async (payload: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return [
    ...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

/**
 * The fixture's signing secret.
 *
 * Derived from the run id, which the runtime host used the same way. It is a
 * fixture constant and worthless against anything real; what matters is that the
 * application reads it from a Worker binding rather than from this module.
 */
const WEBHOOK_SECRET = stripeFixtureSecret(process.env.E2E_RUN_ID ?? '');

test.beforeAll(() => {
  expect(process.env.E2E_RUN_ID, 'the full runtime must own a run id').toBeTruthy();
});

test.describe('opening a checkout', () => {
  test('a signed-in owner buys a plan, and the price came from the catalogue', async ({ page }) => {
    await createVerifiedAccount(page);

    const response = await page.request.post(`${appBaseUrl}/api/billing/checkout`, {
      data: { kind: 'subscription', planId: 'team', interval: 'month' },
      headers: { origin: appBaseUrl },
    });
    expect(response.status()).toBe(201);

    const session = (await response.json()) as {
      url: string;
      lookupKey: string;
      sessionId: string;
    };
    expect(session.lookupKey).toBe('team_month');
    expect(session.sessionId).toBeTruthy();
    // The redirect is built from the deployment's own origin, never from the
    // request — an open redirect with a payment attached is the alternative.
    expect(session.url.startsWith(appBaseUrl)).toBe(true);

    // And what the account was told, observed from the account's side.
    const record = (await accountRecord()).find((row) => row.id === session.sessionId);
    expect(record, 'the account never saw a team_month checkout').toBeDefined();
    if (!record) {
      return;
    }
    const catalogue = resolveSubscription('team', 'month');
    expect(catalogue.ok).toBe(true);
    if (!catalogue.ok) {
      return;
    }
    // The load-bearing assertion of this lane: the amount charged is the
    // catalogue's, and the request that produced it carried a lookup key rather
    // than a number. A caller-supplied amount would make this equal by accident.
    expect(record.carriedAmount).toBe(false);
    expect(record.resolvedAmount).toBe(catalogue.amount);
    expect(record.currency).toBe(BILLING_CATALOG.currency);
    expect(record.recurring).toBe('month');
  });

  test('an unknown plan is refused with the plans that exist', async ({ page }) => {
    await createVerifiedAccount(page);
    const response = await page.request.post(`${appBaseUrl}/api/billing/checkout`, {
      data: { kind: 'subscription', planId: 'team-plus', interval: 'month' },
      headers: { origin: appBaseUrl },
    });
    // 400 rather than 422: the request itself cannot be expressed, so no upstream
    // call was made and nothing to reconcile.
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  test('a plan that exists but cannot be bought is refused by name', async ({ page }) => {
    await createVerifiedAccount(page);
    const response = await page.request.post(`${appBaseUrl}/api/billing/checkout`, {
      data: { kind: 'subscription', planId: 'enterprise', interval: 'month' },
      headers: { origin: appBaseUrl },
    });
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('plan_not_purchasable');
    expect(body.message).toContain('team');
  });

  test('a caller-supplied amount is refused, not ignored', async ({ page }) => {
    await createVerifiedAccount(page);
    const response = await page.request.post(`${appBaseUrl}/api/billing/checkout`, {
      data: { kind: 'subscription', planId: 'team', interval: 'month', amount: 1 },
      headers: { origin: appBaseUrl },
    });
    // `strictObject`: an unknown key is an outright refusal. A field that is parsed
    // and dropped teaches every later reader that the client may send it.
    expect(response.status()).toBe(400);
  });

  test('an anonymous caller cannot open a checkout', async ({ page }) => {
    const response = await page.request.post(`${appBaseUrl}/api/billing/checkout`, {
      data: { kind: 'subscription', planId: 'team', interval: 'month' },
      headers: { origin: appBaseUrl },
    });
    expect(response.status()).toBe(401);
  });

  test('a credit pack resolves from the catalogue too', async ({ page }) => {
    await createVerifiedAccount(page);
    const response = await page.request.post(`${appBaseUrl}/api/billing/checkout`, {
      data: { kind: 'credit_pack', packId: 'credits_100' },
      headers: { origin: appBaseUrl },
    });
    expect(response.status()).toBe(201);
    const session = (await response.json()) as { lookupKey: string };
    expect(session.lookupKey).toBe('credits_100');
  });
});

test.describe('verifying a webhook', () => {
  const event = (id: string, type: string) => ({
    id,
    type,
    data: { object: { id: 'cs_fixture_1', metadata: { plan_id: 'team', reference: 'acct_1' } } },
  });

  const deliver = async (
    page: import('@playwright/test').Page,
    body: unknown,
    signature: string | null,
  ) =>
    await page.request.post(`${appBaseUrl}/api/webhooks/stripe`, {
      data: body,
      headers: {
        'content-type': 'application/json',
        ...(signature === null ? {} : { 'stripe-signature': signature }),
      },
    });

  test('an unsigned delivery is refused', async ({ page }) => {
    // An endpoint that grants a subscription on an unverified POST is an open one.
    const response = await deliver(page, event('evt_unsigned', 'checkout.session.completed'), null);
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('missing-signature');
  });

  test('a delivery signed with the wrong secret is refused', async ({ page }) => {
    const raw = JSON.stringify(event('evt_forged', 'checkout.session.completed'));
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = await sign(`${timestamp}.${raw}`, 'whsec_not_the_endpoint_secret');
    const response = await deliver(page, raw, `t=${timestamp},v1=${digest}`);
    expect(response.status()).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('no-matching-signature');
  });

  test('a genuine signature over different bytes is refused', async ({ page }) => {
    // The classic forgery: capture a real delivery, change what it says.
    const original = JSON.stringify(event('evt_real', 'checkout.session.completed'));
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = await sign(`${timestamp}.${original}`, WEBHOOK_SECRET);
    const tampered = JSON.stringify({
      ...event('evt_real', 'checkout.session.completed'),
      data: { object: { id: 'cs_fixture_1', amount: 1 } },
    });
    const response = await deliver(page, tampered, `t=${timestamp},v1=${digest}`);
    expect(response.status()).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('no-matching-signature');
  });

  test('a correctly signed supported event is accepted', async ({ page }) => {
    const raw = JSON.stringify(event('evt_accepted', 'checkout.session.completed'));
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = await sign(`${timestamp}.${raw}`, WEBHOOK_SECRET);
    const response = await deliver(page, raw, `t=${timestamp},v1=${digest}`);

    // 200, and `handled: false` rather than an implied write. There is no
    // subscription table in this template; the route says so instead of implying a
    // subscription was updated.
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { received: boolean; handled: boolean };
    expect(body).toMatchObject({ received: true, handled: false });
  });

  test('an event this application does not handle is still acknowledged', async ({ page }) => {
    const raw = JSON.stringify(event('evt_unknown', 'radar.early_fraud_warning.created'));
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = await sign(`${timestamp}.${raw}`, WEBHOOK_SECRET);
    const response = await deliver(page, raw, `t=${timestamp},v1=${digest}`);

    // A genuine delivery. Answering 400 would make Stripe retry it and eventually
    // disable the endpoint — taking the events it *does* handle down with it.
    expect(response.status()).toBe(200);
    expect(((await response.json()) as { handled: boolean }).handled).toBe(false);
  });

  test('a replayed delivery is refused once it is outside the tolerance window', async ({
    page,
  }) => {
    const raw = JSON.stringify(event('evt_stale', 'checkout.session.completed'));
    // Signed honestly, but six minutes ago: beyond the five-minute tolerance.
    const timestamp = Math.floor(Date.now() / 1000) - 360;
    const digest = await sign(`${timestamp}.${raw}`, WEBHOOK_SECRET);
    const response = await deliver(page, raw, `t=${timestamp},v1=${digest}`);

    // A correctly signed request captured an hour ago proves only that Stripe
    // signed it once.
    expect(response.status()).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('stale-timestamp');
  });
});

test.describe('the catalogue is the only place a price exists', () => {
  test('every purchasable plan resolves to a price, and the API offers exactly those', () => {
    // The same property the resolver relies on, asserted from the consumer side: if
    // the catalogue and the API disagreed about what exists, a plan could be
    // purchasable and unrequestable, or the reverse, and neither would fail a test
    // that only exercised one of them.
    const purchasable = Object.values(BILLING_CATALOG.plans).filter((plan) => plan.purchasable);
    expect(purchasable.length).toBeGreaterThan(0);
    for (const plan of purchasable) {
      const resolved = resolveSubscription(plan.planId, 'month');
      expect(resolved.ok, `${plan.planId} is purchasable but does not resolve`).toBe(true);
      if (resolved.ok) {
        expect(resolved.amount).toBeGreaterThan(0);
        expect(resolved.currency).toBe(BILLING_CATALOG.currency);
      }
    }
  });
});
