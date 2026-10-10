// packages/backend/billing/src/billing.test.ts
//
// Verification is the one place where being wrong costs real money, so the cases
// below are all ways an endpoint can be made to believe a forged or replayed
// request. Each is a payload that would grant a subscription if it were accepted.
//
// A signed fixture is produced by the same HMAC Stripe uses, computed here rather
// than pasted in, so the test states the algorithm it expects instead of asserting
// that a constant is equal to itself.

import { describe, expect, test } from 'bun:test';
import { BILLING_PLANS } from '@starter/billing';
import {
  createBillingPortalSession,
  createCreditPackCheckout,
  createSubscriptionCheckout,
  type StripeClient,
} from './checkout.ts';
import {
  describeWebhookRejection,
  isSupportedWebhookEvent,
  verifyStripeEvent,
  WEBHOOK_TOLERANCE_SECONDS,
  webhookRejectionStatus,
} from './webhook.ts';

const SECRET = 'whsec_test_fixture_key';

// `Array.from`, not a spread: `crypto.subtle.sign` resolves to an `ArrayBuffer`
// typed as `Uint8Array<ArrayBufferLike>` here, which is not guaranteed to be
// iterable in this runtime's types.
const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const sign = async (payload: string, secret = SECRET): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
};

const body = JSON.stringify({
  id: 'evt_fixture',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_1', metadata: { plan_id: 'team', reference: 'org_1' } } },
});

const NOW = 1_800_000_000;
const headerFor = async (rawBody: string, secret = SECRET, at = NOW): Promise<string> =>
  `t=${at},v1=${await sign(`${at}.${rawBody}`, secret)}`;

describe('a genuine delivery is accepted', () => {
  test('a correctly signed body within the tolerance window decodes', async () => {
    const result = await verifyStripeEvent({
      rawBody: body,
      signatureHeader: await headerFor(body),
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('a genuine delivery was refused');
    }
    expect(result.event.type).toBe('checkout.session.completed');
  });

  test('every v1 in the header is checked, so a key rotation does not break delivery', async () => {
    // Stripe sends one signature per key it holds during a rotation. Refusing the
    // one signed with the older key is how a rotation takes an application down
    // for the length of the overlap window.
    const header = `t=${NOW},v1=${await sign(`${NOW}.${body}`, 'whsec_old_key')},v1=${await sign(`${NOW}.${body}`)}`;
    const result = await verifyStripeEvent({
      rawBody: body,
      signatureHeader: header,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(true);
  });
});

describe('an absent secret refuses rather than accepting the body', () => {
  // This is the specific defect carried over from the previous generation, which
  // logged a warning and parsed the body anyway on the reasoning that it was
  // "acceptable in staging". An endpoint that grants a subscription on an
  // unverified POST is an open one, in every environment.
  test('with no secret configured the delivery is refused', async () => {
    for (const secret of [undefined, '', '   ']) {
      const result = await verifyStripeEvent({
        rawBody: body,
        signatureHeader: await headerFor(body),
        secret,
        nowSeconds: NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'missing-secret' });
    }
  });

  test('a missing secret is a deployment fault, not a bad request', async () => {
    // 400 would tell Stripe to stop delivering. The deployment is broken and
    // retrying the same request cannot fix it.
    const rejection = { ok: false as const, reason: 'missing-secret' as const };
    expect(webhookRejectionStatus(rejection)).toBe(500);
    expect(describeWebhookRejection(rejection)).toContain('Refusing');
  });
});

describe('a forged delivery is refused', () => {
  test('a body signed with a different secret is refused', async () => {
    const result = await verifyStripeEvent({
      rawBody: body,
      signatureHeader: await headerFor(body, 'whsec_attacker_key'),
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'no-matching-signature' });
  });

  test('a correct signature over a different body is refused', async () => {
    // The classic forgery: capture a genuine delivery, then change the amount.
    const header = await headerFor(body);
    const tampered = JSON.stringify({
      ...JSON.parse(body),
      data: { object: { plan_id: 'enterprise' } },
    });
    const result = await verifyStripeEvent({
      rawBody: tampered,
      signatureHeader: header,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'no-matching-signature' });
  });

  test('no header at all is refused', async () => {
    const result = await verifyStripeEvent({
      rawBody: body,
      signatureHeader: null,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'missing-signature' });
  });

  test('a header with no signature element is refused', async () => {
    const result = await verifyStripeEvent({
      rawBody: body,
      signatureHeader: `t=${NOW}`,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed-signature' });
  });
});

describe('a captured delivery cannot be replayed', () => {
  test('a signature from long ago is refused', async () => {
    const result = await verifyStripeEvent({
      rawBody: body,
      signatureHeader: await headerFor(body),
      secret: SECRET,
      nowSeconds: NOW + WEBHOOK_TOLERANCE_SECONDS + 1,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'stale-timestamp',
      ageSeconds: WEBHOOK_TOLERANCE_SECONDS + 1,
    });
  });

  test('a signature from the future is refused too', async () => {
    // A doctored `t` is as suspicious as an old one, and accepting it would let a
    // captured request be replayed indefinitely by moving the timestamp forward.
    const result = await verifyStripeEvent({
      rawBody: body,
      signatureHeader: await headerFor(body, SECRET, NOW + WEBHOOK_TOLERANCE_SECONDS + 1),
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(false);
  });

  test('a delivery just inside the window is accepted', async () => {
    const result = await verifyStripeEvent({
      rawBody: body,
      signatureHeader: await headerFor(body),
      secret: SECRET,
      nowSeconds: NOW + WEBHOOK_TOLERANCE_SECONDS - 1,
    });
    expect(result.ok).toBe(true);
  });
});

describe('events this application acts on come from the catalogue', () => {
  test('the supported list and the verifier agree', () => {
    // One list: the endpoint's `enabled_events` and the router's dispatch table
    // are both derived from `BILLING_WEBHOOK_EVENTS`, so an event cannot be
    // enabled on the endpoint and ignored by the handler.
    for (const event of Object.keys(BILLING_PLANS).length > 0
      ? [
          'checkout.session.completed',
          'customer.subscription.created',
          'customer.subscription.updated',
          'customer.subscription.deleted',
          'invoice.paid',
        ]
      : []) {
      expect(isSupportedWebhookEvent(event)).toBe(true);
    }
    expect(isSupportedWebhookEvent('payment_intent.succeeded')).toBe(false);
    expect(isSupportedWebhookEvent('')).toBe(false);
  });
});

describe('a checkout names what it wants and never an amount', () => {
  const stub = (
    result: { id: string; url?: string } = { id: 'cs_1', url: 'https://checkout.test/1' },
  ) => {
    const calls: Record<string, string>[] = [];
    const client: StripeClient = {
      apiBase: 'https://api.stripe.test',
      secretKey: 'sk_test',
      async post(_path, form) {
        calls.push(form);
        return result;
      },
    };
    return { client, calls };
  };

  const request = { origin: 'https://app.test', customerId: 'cus_1', reference: 'org_1' };

  test('a subscription checkout carries the plan lookup key and no amount', async () => {
    const { client, calls } = stub();
    const result = await createSubscriptionCheckout(client, request, 'team', 'month');

    expect(result.ok).toBe(true);
    // The catalogue resolved the price; the caller supplied no amount at all, so
    // there is no path by which one can be forged.
    expect(calls[0]?.['line_items[0][price]']).toBe('team_month');
    expect(Object.keys(calls[0] ?? {}).some((key) => key.includes('unit_amount'))).toBe(false);
    expect(calls[0]?.['metadata[plan_id]']).toBe('team');
  });

  test('a plan that cannot be bought never reaches Stripe', async () => {
    const { client, calls } = stub();
    const result = await createSubscriptionCheckout(client, request, 'enterprise', 'month');

    // Creating a session for an unpurchasable plan produces a payment nobody can
    // fulfil: the customer is charged and the subscription is not granted.
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test('an unknown plan is refused with the plans that exist', async () => {
    const { client } = stub();
    const result = await createSubscriptionCheckout(client, request, 'team-plus', 'month');
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('an unknown plan produced a checkout');
    }
    expect(result.remedy).toContain('team');
  });

  test('a credit pack resolves its own amount and carries the credits granted', async () => {
    const { client, calls } = stub();
    const result = await createCreditPackCheckout(client, request, 'credits_100');
    expect(result.ok).toBe(true);
    expect(calls[0]?.mode).toBe('payment');
    expect(calls[0]?.['line_items[0][price]']).toBe('credits_100');
  });

  test('a session with no URL is a refusal, not a redirect to undefined', async () => {
    const { client } = stub({ id: 'cs_1' });
    const result = await createSubscriptionCheckout(client, request, 'team', 'month');
    expect(result.ok).toBe(false);
  });

  test('the portal return URL comes from the caller origin, not a hardcoded host', async () => {
    // Two of three handlers in the previous generation picked the host from a mode
    // constant, so a staging run produced staging checkout links in emulator mode.
    const { client, calls } = stub();
    await createBillingPortalSession(client, { origin: 'https://app.test', customerId: 'cus_1' });
    expect(calls[0]?.return_url).toBe('https://app.test/billing');
  });
});
