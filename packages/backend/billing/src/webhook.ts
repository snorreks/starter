// packages/backend/billing/src/webhook.ts
//
// Proving a Stripe webhook is genuine.
//
// This is the one piece of billing code where being wrong costs real money, so
// the rules are stated rather than inferred and each one closes a specific hole.
//
// **The previous generation of this code accepted unverified webhooks.** When
// `STRIPE_WEBHOOK_SECRET` was absent it logged a warning and parsed the body as
// JSON anyway, on the reasoning that this was "acceptable in staging". It is not
// acceptable anywhere: an endpoint that grants a subscription on an unverified
// POST is an open subscription-granting endpoint, and the deployments that are
// *not* staging are the ones that would be running it. An absent secret is now a
// refusal, not a fallback.
//
// **Why no Stripe SDK.** Verification is HMAC-SHA256 over
// `"{timestamp}.{rawBody}"` with the endpoint secret, and WebCrypto is provided by
// every runtime this package runs in. The SDK would add a dependency whose pinned
// version would then have to be kept in step with the one the tooling uses; the
// algorithm is a dozen lines and does not change.
//
// **Why the timestamp matters.** Without a freshness check a captured, correctly
// signed request replays forever. A signature that was valid an hour ago proves
// only that it was signed by Stripe once.

import { BILLING_WEBHOOK_EVENTS, type BillingWebhookEvent } from '@starter/billing';

/** Five minutes. Stripe's own guidance, and short enough to blunt a replay. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type WebhookRejection =
  | { readonly ok: false; readonly reason: 'missing-secret' }
  | { readonly ok: false; readonly reason: 'missing-signature' }
  | { readonly ok: false; readonly reason: 'malformed-signature' }
  | { readonly ok: false; readonly reason: 'no-matching-signature' }
  | { readonly ok: false; readonly reason: 'stale-timestamp'; readonly ageSeconds: number };

export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly data: { readonly object: Record<string, unknown> };
}

/**
 * A constant-time comparison.
 *
 * `===` on two hex digests returns as soon as they differ, so the time taken leaks
 * how many leading characters matched. That is a real side channel against an HMAC
 * and it costs nothing to close.
 */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
};

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const sign = async (secret: string, payload: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
};

/**
 * Verify and decode one webhook delivery.
 *
 * `rawBody` must be the bytes Stripe signed, not a re-serialisation. Parsing and
 * re-stringifying changes key order and whitespace, and the digest no longer
 * matches — which is why the route reads bounded raw text and hands the string
 * straight through.
 *
 * Returns a rejection rather than throwing, because every rejection has a
 * different cause and a different response: a bad signature is a 400 to be
 * dropped, an unsupported event is a 200 to be acknowledged, and a missing secret
 * is a 500 because the *deployment* is misconfigured and retrying will not help.
 */
export const verifyStripeEvent = async (options: {
  rawBody: string;
  signatureHeader: string | null | undefined;
  secret: string | undefined;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): Promise<{ ok: true; event: StripeEvent } | WebhookRejection> => {
  const { rawBody, signatureHeader, secret } = options;

  // First, because it is the one that means "this deployment is broken" rather
  // than "this request is bad".
  if (secret === undefined || secret.trim().length === 0) {
    return { ok: false, reason: 'missing-secret' };
  }
  if (signatureHeader === null || signatureHeader === undefined || signatureHeader.length === 0) {
    return { ok: false, reason: 'missing-signature' };
  }

  const parts = new Map<string, string[]>();
  for (const element of signatureHeader.split(',')) {
    const [key, value] = element.split('=', 2);
    if (key === undefined || value === undefined) {
      continue;
    }
    parts.set(key.trim(), [...(parts.get(key.trim()) ?? []), value.trim()]);
  }
  const timestamps = parts.get('t');
  const signatures = parts.get('v1');
  if (timestamps === undefined || signatures === undefined || timestamps.length === 0) {
    return { ok: false, reason: 'malformed-signature' };
  }

  const timestampText = timestamps[0] ?? '';
  if (!/^\d+$/.test(timestampText)) {
    return { ok: false, reason: 'malformed-signature' };
  }
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp)) {
    return { ok: false, reason: 'malformed-signature' };
  }

  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ageSeconds = now - timestamp;
  // Signed in the future is as suspicious as signed long ago: it means a clock that
  // cannot be trusted, or a replay of a captured request with a doctored `t`.
  if (Math.abs(ageSeconds) > tolerance) {
    return { ok: false, reason: 'stale-timestamp', ageSeconds };
  }

  const expected = await sign(secret.trim(), `${timestampText}.${rawBody}`);
  // Every `v1` in the header is checked, not just the first. Stripe sends one per
  // key it holds during a secret rotation, and rejecting deliveries signed with the
  // older key during the overlap window is how a rotation takes an application
  // down for the length of that window.
  if (!signatures.some((candidate) => timingSafeEqual(candidate, expected))) {
    return { ok: false, reason: 'no-matching-signature' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'malformed-signature' };
  }
  const event = parsed as Partial<StripeEvent>;
  if (typeof event?.id !== 'string' || typeof event.type !== 'string') {
    return { ok: false, reason: 'malformed-signature' };
  }

  return {
    ok: true,
    event: {
      id: event.id,
      type: event.type,
      data: { object: (event.data?.object ?? {}) as Record<string, unknown> },
    },
  };
};

/**
 * Whether this application acts on an event.
 *
 * Deliberately *not* part of {@link WebhookRejection}: an event this code does not
 * handle is still a genuine delivery from Stripe, and it must be acknowledged with
 * 200 rather than 400. Folding it into the rejection union would invite a router
 * that answered 400 for it, which makes Stripe retry an event that will never be
 * handled — or, worse, disables the endpoint after repeated failures.
 */
export const isSupportedWebhookEvent = (type: string): type is BillingWebhookEvent =>
  (BILLING_WEBHOOK_EVENTS as readonly string[]).includes(type);

/** What a rejection means to the caller, so the route can choose its status. */
export const webhookRejectionStatus = (rejection: WebhookRejection): number => {
  switch (rejection.reason) {
    // The deployment is misconfigured. Retrying the same request cannot help, and
    // answering 400 would make Stripe stop delivering real events.
    case 'missing-secret':
      return 500;
    // The request is bad or the request is not Stripe's. Both are dropped.
    default:
      return 400;
  }
};

export const describeWebhookRejection = (rejection: WebhookRejection): string => {
  switch (rejection.reason) {
    case 'missing-secret':
      return (
        'STRIPE_WEBHOOK_SECRET is not configured, so no delivery can be verified. ' +
        'Refusing rather than accepting an unverified body: an endpoint that grants a ' +
        'subscription on an unverified POST is an open one. Set the secret through ' +
        '`bun run deploy:provision`, or run against `bun run dev --stack stripe`.'
      );
    case 'missing-signature':
      return 'The stripe-signature header is absent.';
    case 'malformed-signature':
      return 'The stripe-signature header or the body is not well formed.';
    case 'no-matching-signature':
      return 'No signature in the header matches the body and the configured secret.';
    case 'stale-timestamp':
      return `The signature timestamp is ${rejection.ageSeconds}s from now, outside the ${WEBHOOK_TOLERANCE_SECONDS}s tolerance.`;
  }
};
