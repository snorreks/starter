// apps/e2e/src/full/stripe_fixture.test.ts
//
// The fixture is test code that decides whether a black-box assertion means
// anything, so it is tested like any other code. The specific risk it carries: a
// fixture that resolved *any* price would make "the application sent a lookup key"
// unfalsifiable, because the number in the record would come from the fixture
// rather than from the catalogue.

import { describe, expect, test } from 'bun:test';
import { BILLING_CATALOG, resolveSubscription } from '@starter/billing';
import {
  type RecordedCheckout,
  startStripeFixture,
  stripeFixtureSecret,
} from './stripe_fixture.ts';

/**
 * `V4FetchHandler`'s second parameter is the calling `Miniflare` instance, which
 * Miniflare injects and this fixture never reads — it answers from closed-over state
 * so a request is handled identically whether it came from a Worker or a test.
 *
 * Unreachable rather than absent: a fabricated `Miniflare` would typecheck and
 * quietly make the fixture's dependency on it look real.
 */
const unusedMiniflare = undefined as unknown as Parameters<
  ReturnType<typeof startStripeFixture>['outbound']
>[1];

const origin = 'http://127.0.0.1:5000';
const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

const call = async (
  fixture: ReturnType<typeof startStripeFixture>,
  path: string,
  body = '',
): Promise<{ status: number; json: unknown }> => {
  const request = new Request(`https://api.stripe.com${path}`, {
    method: body === '' ? 'GET' : 'POST',
    body: body === '' ? undefined : body,
  }) as unknown as Parameters<typeof fixture.outbound>[0];
  const response = (await fixture.outbound(request, unusedMiniflare)) as unknown as Response;
  return { status: response.status, json: await response.json() };
};

describe('the fixture resolves prices from the catalogue, not from the request', () => {
  test('a lookup key resolves to the catalogue amount', async () => {
    const fixture = startStripeFixture({ appOrigin: origin, runId: 'fixture_unit' });
    await call(
      fixture,
      '/v1/checkout/sessions',
      form({
        mode: 'subscription',
        customer: 'cus_1',
        'line_items[0][price]': 'team_month',
      }),
    );

    const catalogue = resolveSubscription('team', 'month');
    expect(catalogue.ok).toBe(true);
    if (!catalogue.ok) {
      return;
    }
    const recorded = fixture.checkouts()[0] as RecordedCheckout;
    expect(recorded.resolvedAmount).toBe(catalogue.amount);
    expect(recorded.currency).toBe(BILLING_CATALOG.currency);
    expect(recorded.recurring).toBe('month');
  });

  test('an unknown lookup key is refused rather than invented', async () => {
    const fixture = startStripeFixture({ appOrigin: origin, runId: 'fixture_unit' });
    const result = await call(
      fixture,
      '/v1/checkout/sessions',
      form({ mode: 'subscription', 'line_items[0][price]': 'team_week' }),
    );

    // A fixture that answered with any number would make the black-box assertion
    // "the application sent a key" unfalsifiable: the amount would be the
    // fixture's, so every test would agree with the code it was written for.
    expect(result.status).toBe(400);
    expect(fixture.checkouts()).toHaveLength(0);
  });

  test('a request carrying a unit_amount is recorded as having carried one', async () => {
    const fixture = startStripeFixture({ appOrigin: origin, runId: 'fixture_unit' });
    await call(
      fixture,
      '/v1/checkout/sessions',
      form({ mode: 'subscription', 'line_items[0][price]': 'team_month', unit_amount: '1' }),
    );
    // The assertion the whole lane rests on. A fixture that could not express this
    // would make `carriedAmount` a constant `false` and the check vacuous.
    expect(fixture.checkouts()[0]?.carriedAmount).toBe(true);
  });

  test('a well-formed request records no amount', async () => {
    const fixture = startStripeFixture({ appOrigin: origin, runId: 'fixture_unit' });
    await call(
      fixture,
      '/v1/checkout/sessions',
      form({
        mode: 'payment',
        customer: 'cus_1',
        'line_items[0][price]': 'credits_100',
        'metadata[plan_id]': 'team',
      }),
    );
    const recorded = fixture.checkouts()[0] as RecordedCheckout;
    expect(recorded.carriedAmount).toBe(false);
    expect(recorded.metadata.plan_id).toBe('team');
    expect(recorded.recurring).toBeNull();
  });

  test('a non-Stripe host is not answered', async () => {
    const fixture = startStripeFixture({ appOrigin: origin, runId: 'fixture_unit' });
    const request = new Request('https://evil.example/v1/prices') as unknown as Parameters<
      typeof fixture.outbound
    >[0];
    const response = (await fixture.outbound(request, unusedMiniflare)) as unknown as Response;
    // A fixture that answered every host would swallow a misrouted request.
    expect(response.status).toBe(502);
  });

  test('an unimplemented endpoint is a 404, not a silent success', async () => {
    const fixture = startStripeFixture({ appOrigin: origin, runId: 'fixture_unit' });
    const result = await call(fixture, '/v1/refunds', form({ charge: 'ch_1' }));
    expect(result.status).toBe(404);
  });
});

describe('the fixture secret is a constant, not a credential', () => {
  test('it is derived from the run id so two processes agree', () => {
    expect(stripeFixtureSecret('e2e_abc123')).toBe(stripeFixtureSecret('e2e_abc123'));
    expect(stripeFixtureSecret('e2e_abc123')).not.toBe(stripeFixtureSecret('e2e_xyz789'));
    // Nothing outside the run id reaches it, so it cannot be a secret in any sense.
    expect(stripeFixtureSecret('')).toMatch(/^whsec_fixture_[0-9]*$/);
  });
});
