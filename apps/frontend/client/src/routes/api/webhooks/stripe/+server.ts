// apps/frontend/client/src/routes/api/webhooks/stripe/+server.ts
//
// `/api/webhooks/stripe` — Stripe telling this deployment that money moved.
//
// Transport only. Verification is in `@starter/billing-server` because it is the
// part with security consequences and it deserves to be reviewable on its own; the
// four decisions this route adds are transport-shaped, and each is stated below
// because each one has a counterpart that looks right and is not.
//
//   1. **The raw body, not a parsed one.** `request.text()` hands the exact bytes
//      Stripe signed. Parsing and re-serialising changes key order and whitespace,
//      and the digest no longer matches — which presents as "Stripe's signature
//      verification keeps failing" rather than as a bug here.
//
//   2. **The signature header comes from the request, never from the body.** A
//      body field named `signature` would be the attacker's own input.
//
//   3. **An event this application does not handle is still acknowledged with 200.**
//      It is a genuine delivery; answering 400 makes Stripe retry it forever and,
//      after enough retries, disable the endpoint — taking the events it *does*
//      handle down with it.
//
//   4. **A missing secret is a 500, not a 400.** The deployment is misconfigured.
//      Telling Stripe the request was bad would stop delivery of real events while
//      the actual fault is one env var.

import { BILLING_WEBHOOK_EVENTS } from '@starter/billing';
import {
  describeWebhookRejection,
  isSupportedWebhookEvent,
  verifyStripeEvent,
  webhookRejectionStatus,
} from '@starter/billing-server';
import { json } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/**
 * Stripe's own ceiling, and a bound on what this process will hold.
 *
 * The limit is not defensive padding: it is what stops a single delivery from
 * being the reason an isolate runs out of memory. A delivery over it is refused
 * rather than truncated, because a truncated body cannot be verified — the digest
 * would be of something Stripe never signed.
 */
const MAX_DELIVERY_BYTES = 256 * 1024;

export const POST: RequestHandler = async ({ request, locals }) => {
  const rawBody = await request.text();
  if (rawBody.length > MAX_DELIVERY_BYTES) {
    return json(413, {
      error: 'payload_too_large',
      message: `A Stripe delivery may not exceed ${MAX_DELIVERY_BYTES} bytes.`,
    });
  }

  const verified = await verifyStripeEvent({
    rawBody,
    signatureHeader: request.headers.get('stripe-signature'),
    // Read per request from the bindings, never from module scope: an isolate
    // serves many requests and a captured secret would outlive the one it was read
    // for.
    secret: locals.container.env.STRIPE_WEBHOOK_SECRET,
  });

  if (!verified.ok) {
    const message = describeWebhookRejection(verified);
    return json(webhookRejectionStatus(verified), {
      error: verified.reason,
      message,
    });
  }

  if (!isSupportedWebhookEvent(verified.event.type)) {
    // Acknowledged, not processed. See decision 3 above.
    return json(200, { received: true, handled: false });
  }

  // The delivery is genuine and this application acts on it.
  //
  // What happens next is a database write, and it is not implemented in this
  // template: there is no subscription table, and adding one would mean choosing a
  // schema, an idempotency key and a plan-to-entitlement mapping that a project
  // using this starter will have opinions about. `verified.event.id` is the Stripe
  // event id and is the correct idempotency key — record it before applying
  // anything, so a redelivery of the same event is recognisable rather than
  // applied twice.
  //
  // This route deliberately reports `handled: false` rather than returning 200 and
  // implying the subscription was updated. `BILLING_WEBHOOK_EVENTS` is the list
  // this deployment will be asked about, and the events on it are verified and
  // routed here; nothing is written, and the response says so.
  return json(200, {
    received: true,
    handled: false,
    event: verified.event.id,
    type: verified.event.type,
    supportedEvents: BILLING_WEBHOOK_EVENTS,
  });
};
