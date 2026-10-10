// packages/backend/billing/src/checkout.ts
//
// Creating a Stripe Checkout Session, and the billing portal session after it.
//
// Every amount comes from `@starter/billing` through a resolver. There is no
// `amount` parameter, because an amount arriving from the caller is an amount a
// caller chose — and a previous generation of this code took one, validated it
// against a table, and got the table's keys and the caller's vocabulary out of
// step, so a request could name a tier the catalogue did not have. The request
// names *what* it wants; the catalogue says what that costs.
//
// The Stripe client is passed in rather than held in a module singleton. A Worker
// isolate serves many concurrent requests, and a cached client would pin the first
// request's credentials for every request that followed.

import {
  type BillingInterval,
  CURRENCY,
  resolveCreditPack,
  resolveSubscription,
} from '@starter/billing';

export interface Refusal {
  readonly ok: false;
  readonly problem: string;
  readonly remedy: string;
}

/** The slice of the Stripe API this package uses. Injected, so it can be a stub. */
export interface StripeClient {
  readonly apiBase: string;
  readonly secretKey: string;
  post(path: string, form: Record<string, string>): Promise<{ id: string; url?: string }>;
}

/**
 * A Stripe client over `fetch`.
 *
 * `redirect: 'manual'` on every call: a 3xx from the API would otherwise replay
 * the bearer credential against whatever host it names, and Stripe must never be
 * talked into redirecting a request carrying a secret key.
 */
export const createStripeClient = (
  apiBase: string,
  secretKey: string,
  fetcher: typeof fetch = fetch,
): StripeClient => ({
  apiBase: apiBase.replace(/\/$/, ''),
  secretKey,
  async post(path, form) {
    const response = await fetcher(`${apiBase.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200).trim();
      throw new Error(
        `Stripe rejected ${path} (HTTP ${response.status})${detail === '' ? '' : `: ${detail}`}`,
      );
    }
    return (await response.json()) as { id: string; url?: string };
  },
});

/** Stripe counts in minor units; a negative or fractional amount is a defect. */
const minorUnits = (value: number): string => String(Math.round(value));

export interface CheckoutRequest {
  /** Where Stripe returns the customer. Must be an origin this deployment controls. */
  readonly origin: string;
  /** The Stripe customer id for this account. */
  readonly customerId: string;
  /** Pairs the checkout with the local record that authorised it. */
  readonly reference: string;
}

export interface CheckoutResult {
  readonly ok: true;
  readonly url: string;
  readonly sessionId: string;
}

/**
 * A Checkout Session for a subscription.
 *
 * The plan is resolved first and refused here if it cannot be bought, so an
 * unpurchasable plan never reaches Stripe as a session that will be paid for and
 * then unfulfilled.
 */
export const createSubscriptionCheckout = async (
  client: StripeClient,
  request: CheckoutRequest,
  planId: string,
  interval: BillingInterval,
): Promise<CheckoutResult | Refusal> => {
  const resolved = resolveSubscription(planId, interval);
  if (!resolved.ok) {
    return { ok: false, problem: resolved.problem, remedy: resolved.remedy };
  }

  const session = await client.post('/v1/checkout/sessions', {
    mode: 'subscription',
    customer: request.customerId,
    success_url: `${request.origin}/billing?checkout=success`,
    cancel_url: `${request.origin}/billing?checkout=cancelled`,
    client_reference_id: request.reference,
    'line_items[0][price]': resolved.lookupKey,
    'line_items[0][quantity]': '1',
    // Echoed back on the webhook so the session can be tied to the local record
    // without the webhook having to guess which session produced the event.
    'metadata[plan_id]': resolved.plan.planId,
    'metadata[reference]': request.reference,
    'subscription_data[metadata][plan_id]': resolved.plan.planId,
    'subscription_data[metadata][reference]': request.reference,
  });

  if (typeof session.url !== 'string' || session.url.length === 0) {
    return {
      ok: false,
      problem: 'Stripe accepted the checkout but returned no URL.',
      remedy: 'Check the API version this deployment pins against the Stripe dashboard.',
    };
  }
  return { ok: true, url: session.url, sessionId: session.id };
};

/**
 * A Checkout Session for a one-time credit pack.
 *
 * `mode: 'payment'` and a resolved amount, never a caller-supplied one. The
 * credits granted are carried in metadata rather than applied here: a payment
 * succeeding is not the same fact as the balance having been credited, and the
 * webhook that observes the payment is the thing that writes the ledger.
 */
export const createCreditPackCheckout = async (
  client: StripeClient,
  request: CheckoutRequest,
  packId: string,
): Promise<CheckoutResult | Refusal> => {
  const resolved = resolveCreditPack(packId);
  if (!resolved.ok) {
    return { ok: false, problem: resolved.problem, remedy: resolved.remedy };
  }

  const session = await client.post('/v1/checkout/sessions', {
    mode: 'payment',
    customer: request.customerId,
    success_url: `${request.origin}/billing?checkout=success`,
    cancel_url: `${request.origin}/billing?checkout=cancelled`,
    client_reference_id: request.reference,
    'line_items[0][price]': resolved.lookupKey,
    'line_items[0][quantity]': '1',
    'metadata[pack_id]': resolved.pack.packId,
    'metadata[reference]': request.reference,
  });

  if (typeof session.url !== 'string' || session.url.length === 0) {
    return {
      ok: false,
      problem: 'Stripe accepted the checkout but returned no URL.',
      remedy: 'Check the API version this deployment pins against the Stripe dashboard.',
    };
  }
  return { ok: true, url: session.url, sessionId: session.id };
};

/**
 * A Billing Portal session, so a customer can manage what they already bought.
 *
 * Return URL derived from the caller's `origin` rather than from configuration:
 * a checkout that redirects to staging because a constant was hardcoded is the
 * failure a previous generation of this code had in two of its three handlers.
 */
export const createBillingPortalSession = async (
  client: StripeClient,
  request: { origin: string; customerId: string; returnPath?: string },
): Promise<CheckoutResult | Refusal> => {
  const session = await client.post('/v1/billing_portal/sessions', {
    customer: request.customerId,
    return_url: `${request.origin}${request.returnPath ?? '/billing'}`,
  });

  if (typeof session.url !== 'string' || session.url.length === 0) {
    return {
      ok: false,
      problem: 'Stripe accepted the portal session but returned no URL.',
      remedy: 'Check the API version this deployment pins against the Stripe dashboard.',
    };
  }
  return { ok: true, url: session.url, sessionId: session.id };
};

/** Exported so the catalogue and this module cannot disagree about the currency. */
export const BILLING_CURRENCY = CURRENCY;
export { minorUnits };
