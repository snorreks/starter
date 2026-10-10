// apps/frontend/client/src/routes/api/billing/checkout/+server.ts
//
// `/api/billing/checkout` — open a Stripe Checkout Session.
//
// Transport only. The two decisions with money attached live in
// `@starter/billing-server`: which price a request resolves to, and how a webhook
// proves it is genuine. What this route adds is about the *caller*, and each rule
// is here because the obvious alternative has a failure mode worth naming.
//
//   1. **A signed-in account, and a verified one.** An unverified address cannot be
//      billed and cannot receive the receipt; a checkout for one creates a payment
//      nobody can claim. The email check mirrors `/api/jobs`.
//
//   2. **No amount crosses this boundary.** The body names a plan and an interval.
//      `CheckoutRequestSchema` is a `strictObject`, so a client that sends `amount`
//      is refused outright rather than having the field ignored — a field that is
//      parsed and dropped teaches the next reader that it is allowed.
//
//   3. **The return URL comes from the resolved origin, never from the request.** A
//      caller who names their own `success_url` can point a Stripe redirect at a
//      host they control, which turns this endpoint into an open redirect with a
//      payment attached.
//
// The Stripe customer id is derived from the account id. **That is a stated
// simplification, not a hidden one**: this template has no customers table, so the
// id is `cus_<account id>` — stable and unique per account, which is all the flow
// needs. A deployment with real customer records resolves the id from its own table
// and changes this one line.

import {
  createCreditPackCheckout,
  createStripeClient,
  createSubscriptionCheckout,
} from '@starter/billing-server';
import {
  CHECKOUT_PURCHASABLE_PLAN_IDS,
  CheckoutRequestSchema,
  type CheckoutSession,
} from '@starter/schemas/billing';
import { json, jsonError, readJsonBody, unauthorized } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/**
 * Small on purpose: this body is three short identifiers and nothing else. A larger
 * bound would be an invitation to add a field.
 */
const MAX_BODY_BYTES = 2 * 1024;

/**
 * Whether this deployment can talk to Stripe at all.
 *
 * Named rather than defaulted: a deployment with no Stripe key would otherwise
 * post to the SDK's default host and fail with a 401 from the public API, which
 * reads as bad credentials rather than as an unconfigured deployment.
 */
const unconfigured = (message: string) => jsonError(503, 'stripe_not_configured', message);

export const POST: RequestHandler = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) {
    return unauthorized();
  }
  if (!user.emailVerified) {
    return jsonError(
      403,
      'email_not_verified',
      'Confirm your email address before starting a checkout.',
    );
  }

  const env = locals.container.env;
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? '';
  const apiBase = env.STRIPE_API_BASE?.trim() ?? '';
  if (secretKey.length === 0 || apiBase.length === 0) {
    return unconfigured(
      'This deployment has no Stripe bindings, so a checkout cannot be opened. ' +
        'Set STRIPE_SECRET_KEY and STRIPE_API_BASE, or run `bun run dev --stack stripe`.',
    );
  }

  const parsed = await readJsonBody(request, CheckoutRequestSchema, {
    maxBytes: MAX_BODY_BYTES,
    invalidStatus: 400,
  });
  if (!parsed.ok) {
    return parsed.response;
  }
  const body = parsed.value;

  const client = createStripeClient(apiBase, secretKey);
  const reference = user.id;
  const origin = locals.container.baseUrl;
  const billing = { origin, customerId: `cus_${user.id}`, reference };

  if (body.kind === 'subscription') {
    if (body.planId === undefined || body.interval === undefined) {
      return jsonError(
        400,
        'incomplete_checkout',
        'A subscription checkout names both a plan and an interval.',
      );
    }
    // Naming only purchasable plans is not enough on its own: the catalogue can gain
    // a plan that exists and cannot be bought, and the resolver refuses that with a
    // better message than this route could write.
    if (!CHECKOUT_PURCHASABLE_PLAN_IDS.includes(body.planId)) {
      return jsonError(
        400,
        'plan_not_purchasable',
        `"${body.planId}" is not available for purchase. Available: ${CHECKOUT_PURCHASABLE_PLAN_IDS.join(', ')}.`,
      );
    }

    const result = await createSubscriptionCheckout(client, billing, body.planId, body.interval);
    if (!result.ok) {
      return jsonError(422, 'checkout_refused', `${result.problem} ${result.remedy}`);
    }
    return json(201, {
      kind: 'subscription',
      sessionId: result.sessionId,
      url: result.url,
      lookupKey: `${body.planId}_${body.interval}`,
    } satisfies CheckoutSession);
  }

  if (body.packId === undefined) {
    return jsonError(400, 'incomplete_checkout', 'A credit checkout names a pack.');
  }
  const pack = await createCreditPackCheckout(client, billing, body.packId);
  if (!pack.ok) {
    return jsonError(422, 'checkout_refused', `${pack.problem} ${pack.remedy}`);
  }
  return json(201, {
    kind: 'credit_pack',
    sessionId: pack.sessionId,
    url: pack.url,
    lookupKey: body.packId,
  } satisfies CheckoutSession);
};
