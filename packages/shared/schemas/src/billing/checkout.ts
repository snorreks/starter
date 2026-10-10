// packages/shared/schemas/src/billing/checkout.ts
//
// The only billing request this API can express.
//
// **There is no amount field, and that is the whole point of this file.** A price is
// resolved from `@starter/billing` on the server: the request names *what* it wants
// — a plan and an interval, or a pack — and the catalogue says what that costs. A
// request that carried an amount would be a request whose author chose what it pays,
// and the previous generation of this code had exactly that, validating the number
// against a table that had drifted from the one the handlers used.
//
// `strictObject` is what makes it true rather than merely intended. With
// `additionalProperties: false`, a body carrying `amount` is an outright refusal —
// not an accepted-and-ignored field. A field that is parsed and dropped still
// teaches every future reader that the client may send it.
//
// The unions are imported from the catalogue rather than restated here, so adding a
// plan to `@starter/billing` widens the API and there is no second list of what
// exists to fall out of step.

import { BILLING_INTERVALS, CREDIT_PACK_IDS, PLAN_IDS, purchasablePlans } from '@starter/billing';
import * as v from 'valibot';
import { literalUnion } from '../common/literals.ts';

/**
 * `literalUnion` wants a non-empty tuple, and the catalogue derives its id lists
 * with `Object.keys`, so their type is a plain array.
 *
 * The cast is safe by construction rather than by hope: every one of these lists is
 * a literal `as const` declaration or `Object.keys` over a non-empty object
 * literal, and `catalog.test.ts` fails if any of them is empty. An empty plan list
 * would mean a catalogue with nothing to sell, which is a defect this file cannot
 * meaningfully express as a union.
 */
const nonEmpty = <T extends string>(values: readonly T[]): readonly [T, ...T[]] =>
  values as readonly [T, ...T[]];

/** What kind of thing is being bought. Named, because "amount" is never a request. */
export const CHECKOUT_KINDS = ['subscription', 'credit_pack'] as const;
export const CheckoutKindSchema = literalUnion(CHECKOUT_KINDS);
export type CheckoutKind = v.InferOutput<typeof CheckoutKindSchema>;

export const BillingIntervalSchema = literalUnion(nonEmpty(BILLING_INTERVALS));
export type BillingInterval = v.InferOutput<typeof BillingIntervalSchema>;

export const PlanIdSchema = literalUnion(nonEmpty(PLAN_IDS));
export type BillingPlanId = v.InferOutput<typeof PlanIdSchema>;

export const CreditPackIdSchema = literalUnion(nonEmpty(CREDIT_PACK_IDS));
export type BillingCreditPackId = v.InferOutput<typeof CreditPackIdSchema>;

/**
 * A request to open a checkout.
 *
 * All three selector fields are optional individually and required *in
 * combination*: a subscription names a plan and an interval, a pack names only a
 * pack. The route resolves that pairing rather than this schema, because the rule is
 * about which two fields travel together — which is a statement about a request's
 * meaning, not about the shape of any one field.
 */
export const CheckoutRequestSchema = v.strictObject({
  kind: CheckoutKindSchema,
  planId: v.optional(PlanIdSchema),
  interval: v.optional(BillingIntervalSchema),
  packId: v.optional(CreditPackIdSchema),
});
export type CheckoutRequest = v.InferOutput<typeof CheckoutRequestSchema>;

/** What the route answers with on success. */
export const CheckoutSessionSchema = v.strictObject({
  kind: CheckoutKindSchema,
  /** The Stripe session id, for reconciliation against a later webhook. */
  sessionId: v.string(),
  /** Where Stripe will send the customer. Never constructed from a caller value. */
  url: v.string(),
  /**
   * The lookup key the price was resolved under — `team_month`, `credits_100`.
   *
   * Returned so a client can tell *which* catalogue entry was bought without the
   * server echoing an amount back, and so a black-box test can assert the lookup
   * key rather than a number it would otherwise have to trust.
   */
  lookupKey: v.string(),
});
export type CheckoutSession = v.InferOutput<typeof CheckoutSessionSchema>;

/**
 * The plans the API will open a checkout for.
 *
 * Exported rather than left implicit in the route: a plan that exists in the
 * catalogue but cannot be bought is not expressible as a request, and a caller
 * deserves a refusal that names the ones that work.
 */
export const CHECKOUT_PURCHASABLE_PLAN_IDS = purchasablePlans().map((plan) => plan.planId);
