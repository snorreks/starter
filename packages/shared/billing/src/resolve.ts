// packages/shared/billing/src/resolve.ts
//
// Turning a request into a price, in one place.
//
// The Worker and the provisioning CLI must agree on what "the user asked for
// plan X billed monthly" means: which amount, which Stripe lookup key, whether
// that combination is even for sale. If each side assembled that from the
// catalogue independently they would agree today and diverge the first time a
// plan was added, which is exactly the class of bug the catalogue was extracted
// to remove.
//
// So the derivations live here rather than at either call site, and every one
// returns an explicit refusal instead of `undefined` or a throw. A refusal
// carries the reason *and* the remedy, because both callers need to show it to a
// human and a caller that receives `undefined` has no way to tell a missing plan
// from a bug in its own key construction.

import {
  BILLING_CATALOG,
  BILLING_PLANS,
  type BillingInterval,
  type BillingPlan,
  CREDIT_PACKS,
  type CreditPack,
  type CreditPackId,
  CURRENCY,
  isCreditPackId,
  isPlanId,
  type PlanId,
} from './catalog.ts';

/** A refusal with a stated cause and a stated next step. */
export interface Refusal {
  readonly ok: false;
  readonly problem: string;
  readonly remedy: string;
}

export type Resolution<T> = ({ readonly ok: true } & T) | Refusal;

const refuse = (problem: string, remedy: string): Refusal => ({ ok: false, problem, remedy });

/**
 * The Stripe price lookup key for a plan and interval.
 *
 * Derived rather than stored, because a stored lookup key is a fourth place the
 * plan identity lives and can be edited without the price moving with it. The
 * derivation is also what makes re-running `stripe:setup` idempotent: the key a
 * price was created under is recomputed rather than remembered.
 */
export const planPriceLookupKey = (planId: PlanId, interval: BillingInterval): string =>
  `${planId}_${interval}`;

/** The Stripe price lookup key for a one-time credit pack. */
export const creditPackPriceLookupKey = (packId: CreditPackId): string => packId;

export const planById = (planId: string): BillingPlan | undefined =>
  isPlanId(planId) ? BILLING_PLANS[planId as PlanId] : undefined;

export const creditPackById = (packId: string): CreditPack | undefined =>
  isCreditPackId(packId) ? CREDIT_PACKS[packId as CreditPackId] : undefined;

/** The plans that can actually be bought, in catalogue order. */
export const purchasablePlans = (): readonly BillingPlan[] =>
  Object.values(BILLING_PLANS).filter((plan) => plan.purchasable);

/**
 * Resolve a subscription request to a concrete, chargeable price.
 *
 * Three distinct refusals rather than one, because they need three different
 * answers from the caller: a typo is the caller's bug, an unpurchasable plan is
 * a sales conversation, and a zero amount means the catalogue and the caller
 * disagree about a real product.
 */
export const resolveSubscription = (
  planId: string,
  interval: BillingInterval,
): Resolution<{ plan: BillingPlan; amount: number; lookupKey: string; currency: string }> => {
  const plan = planById(planId);
  if (plan === undefined) {
    return refuse(`Unknown plan "${planId}".`, `Plans: ${Object.keys(BILLING_PLANS).join(', ')}.`);
  }
  if (!plan.purchasable) {
    return refuse(
      `Plan "${plan.planId}" is not purchasable from the application.`,
      `Purchasable plans: ${purchasablePlans()
        .map((candidate) => candidate.planId)
        .join(', ')}.`,
    );
  }
  const amount = plan.amount[interval];
  if (amount <= 0) {
    return refuse(
      `Plan "${plan.planId}" has no ${interval}ly price.`,
      `Set BILLING_PLANS.${plan.planId}.amount.${interval} to a positive amount in minor units, ` +
        `or remove ${interval} from the interval a checkout may request.`,
    );
  }
  return {
    ok: true,
    plan,
    amount,
    lookupKey: planPriceLookupKey(plan.planId as PlanId, interval),
    currency: CURRENCY,
  };
};

/** Resolve a one-time credit purchase to a concrete, chargeable price. */
export const resolveCreditPack = (
  packId: string,
): Resolution<{ pack: CreditPack; amount: number; creditsMinor: number; lookupKey: string }> => {
  const pack = creditPackById(packId);
  if (pack === undefined) {
    return refuse(
      `Unknown credit pack "${packId}".`,
      `Packs: ${Object.keys(CREDIT_PACKS).join(', ')}.`,
    );
  }
  if (pack.amount <= 0) {
    return refuse(
      `Credit pack "${pack.packId}" has a non-positive price.`,
      `Set BILLING_CATALOG.plans... creditPacks.${pack.packId}.amount to a positive amount in minor units.`,
    );
  }
  return {
    ok: true,
    pack,
    amount: pack.amount,
    creditsMinor: pack.creditsMinor,
    lookupKey: creditPackPriceLookupKey(pack.packId as CreditPackId),
  };
};

/**
 * What a Stripe product should carry for a plan.
 *
 * Includes `plan_id` explicitly rather than trusting every caller to remember it:
 * the provisioning CLI and any future import both build product metadata from
 * here, and an object created without `plan_id` is one the next run cannot find,
 * so it would be duplicated instead of reconciled.
 */
export const planProductMetadata = (plan: BillingPlan): Record<string, string> => ({
  plan_id: plan.planId,
  ...plan.entitlements,
});

/** The interval an event refers to, or `null` when its price carries none. */
export const intervalOfRecurringPrice = (
  recurring:
    | {
        readonly interval?: string;
      }
    | null
    | undefined,
): BillingInterval | null => {
  const interval = recurring?.interval;
  return interval === 'month' || interval === 'year' ? interval : null;
};

/** The plan a Stripe object belongs to, read back from its metadata. */
export const planIdFromMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): PlanId | null => {
  const planId = metadata?.plan_id;
  return typeof planId === 'string' && isPlanId(planId) ? planId : null;
};

/**
 * Credits granted by a period's invoice.
 *
 * Reads the plan rather than a handler-side table, and returns `null` rather than
 * zero when the plan is unknown: `null` means "do not grant anything, and do not
 * record that a grant happened", which is a different act from granting zero.
 * Collapsing the two writes a ledger entry that says the customer was credited
 * nothing when in fact the plan was not recognised.
 */
export const periodGrantFor = (planId: string): number | null =>
  planById(planId)?.periodGrantMinor ?? null;

export const CATALOG_SUMMARY = {
  currency: BILLING_CATALOG.currency,
  planCount: Object.keys(BILLING_PLANS).length,
  purchasablePlanCount: purchasablePlans().length,
  creditPackCount: Object.keys(CREDIT_PACKS).length,
  webhookEventCount: BILLING_CATALOG.webhookEvents.length,
} as const;
