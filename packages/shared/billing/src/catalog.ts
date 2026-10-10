// packages/shared/billing/src/catalog.ts
//
// The single source of truth for what this project sells.
//
// Every price that appears in a Stripe object, on a pricing page, in a checkout
// amount validation and in a webhook grant originates here. The provisioning CLI
// (`bun run stripe:setup`) reads this file and writes; the Worker reads it and
// charges. Neither hardcodes an amount, so a price cannot be correct in one place
// and stale in the other.
//
// **Why this lives in a portable package rather than beside the Stripe handlers.**
// The Worker needs it to validate what a caller is asking to buy, and the tooling
// needs it to decide what to create in Stripe. `scripts/` is on the `node` plane
// and `packages/backend/*` is on the `worker` plane, and `MAY_REACH` in
// `scripts/src/guards/policy.ts` forbids `node -> worker`. A catalog that both
// planes must read therefore has to be portable, and a pricing table is the
// clearest possible case of "portable means it has no runtime, not that it is
// trivial": this file imports nothing, so it loads in a browser, in workerd and
// under Bun identically.
//
// **The failures this shape prevents.** A previous single-source-of-truth for
// this same concern kept the plan tiers under one set of names and the checkout
// amount under another, so a request could name a tier the catalog did not have;
// it declared the currency in one module and typed `'usd'` at the three call
// sites that spent money; it listed five webhook events while the handler
// implemented six, so the sixth was never enabled on the endpoint and arrived in
// production never; and it kept the monthly grants in a table beside the handler
// rather than on the plan they belong to. Each of those is a value in two places,
// and the repository's rule is that a value in more than one place is a value
// nobody can tell is in effect.
//
// So: one vocabulary, one currency, one event list, and grants attached to the
// plan that grants them. `catalog.test.ts` asserts the shapes that would
// otherwise be conventions.

/**
 * Minor units of the only currency this project charges in.
 *
 * Declared once and *read* by every consumer — the catalogue, the checkout
 * amount check and the provisioning CLI all resolve prices through it. A literal
 * `'eur'` or `'usd'` written at a call site is the defect this constant exists to
 * make impossible to introduce quietly.
 */
export const CURRENCY = 'eur';

/**
 * The Stripe events this application acts on.
 *
 * This list is simultaneously what `stripe:setup` enables on the webhook endpoint
 * and what the Worker routes. They cannot drift because there is one list: a
 * handler added without adding its event here fails `unsupported_event`, and an
 * event added here without a handler fails the same way at runtime rather than
 * being silently enabled on the endpoint and ignored.
 */
export const BILLING_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
] as const;

export type BillingWebhookEvent = (typeof BILLING_WEBHOOK_EVENTS)[number];

/** How often a subscription bills. */
export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export interface BillingPlan {
  /**
   * Stable identity, written to `metadata.plan_id` and embedded in every derived
   * lookup key. Never the display name and never the price: changing either must
   * not orphan the objects already created in Stripe.
   */
  readonly planId: string;
  readonly name: string;
  readonly description: string;
  /** Price per interval, in minor units of {@link CURRENCY}. */
  readonly amount: Readonly<Record<BillingInterval, number>>;
  /**
   * Nonsecret plan entitlements, written verbatim to the Stripe product's
   * metadata so a webhook can read back what was sold without a second lookup.
   */
  readonly entitlements: Readonly<Record<string, string>>;
  /**
   * Credits granted each period, in minor units of the credit unit, or `null`
   * for a plan that grants nothing.
   *
   * On the plan rather than in the grant handler, because "how much does this
   * tier give me per month" is a property of the tier. A handler-side table is a
   * second place to forget to update, and it is invisible when it disagrees.
   */
  readonly periodGrantMinor: number | null;
  readonly features: readonly string[];
  /** False for a plan that cannot be bought yet; the CLI skips it and says so. */
  readonly purchasable: boolean;
}

export interface CreditPack {
  /** Stable identity, and the stem of this pack's price lookup key. */
  readonly packId: string;
  readonly name: string;
  readonly description: string;
  /** Charged amount, in minor units of {@link CURRENCY}. */
  readonly amount: number;
  /** Credits granted. Not equal to `amount`, and never derived from it. */
  readonly creditsMinor: number;
}

export const BILLING_PLANS = {
  starter: {
    planId: 'starter',
    name: 'Starter',
    description: 'Everything a single developer needs to evaluate the platform.',
    amount: { month: 0, year: 0 },
    entitlements: { max_seats: '1', audit_retention_days: '7' },
    periodGrantMinor: 5_000,
    features: ['1 seat', '7 days of audit retention', 'Community support'],
    // Purchasable is false even though this plan is free, and the two facts are
    // the same fact: a Checkout Session charges a card, so a plan with no price
    // has nothing to create one for. The free tier is *granted*, not bought,
    // and marking it purchasable is what let a zero price sit in the catalogue
    // where the resolver is supposed to refuse one. It stays in the catalogue so
    // a subscription webhook about it is understood rather than rejected.
    purchasable: false,
  },
  team: {
    planId: 'team',
    name: 'Team',
    description: 'Shared projects, longer retention and priority support.',
    amount: { month: 2_900, year: 29_000 },
    entitlements: { max_seats: '10', audit_retention_days: '90' },
    periodGrantMinor: 100_000,
    features: ['10 seats', '90 days of audit retention', 'Priority support'],
    purchasable: true,
  },
  enterprise: {
    planId: 'enterprise',
    name: 'Enterprise',
    description: 'Contact sales for seat counts above ten and custom retention.',
    amount: { month: 0, year: 0 },
    entitlements: { max_seats: '0', audit_retention_days: '0', sales_contact: 'true' },
    periodGrantMinor: null,
    features: ['Negotiable seats', 'Negotiable retention', 'Named contact'],
    // Not purchasable, and deliberately still present: the plan has to exist in
    // the catalogue for a webhook about it to be understood, even though nothing
    // creates a Checkout Session for it. A catalogue that only lists what can be
    // sold cannot describe an existing subscription.
    purchasable: false,
  },
} as const satisfies Record<string, BillingPlan>;

export const CREDIT_PACKS = {
  credits_20: {
    packId: 'credits_20',
    name: '20 credits',
    description: 'A small top-up for an established project.',
    amount: 2_000,
    creditsMinor: 20_000,
  },
  credits_100: {
    packId: 'credits_100',
    name: '100 credits',
    description: 'The usual top-up, with the bonus applied.',
    amount: 10_000,
    creditsMinor: 120_000,
  },
} as const satisfies Record<string, CreditPack>;

export const BILLING_CATALOG = {
  currency: CURRENCY,
  webhookEvents: BILLING_WEBHOOK_EVENTS,
  plans: BILLING_PLANS,
  creditPacks: CREDIT_PACKS,
} as const;

export type PlanId = keyof typeof BILLING_PLANS;
export type CreditPackId = keyof typeof CREDIT_PACKS;

export const PLAN_IDS = Object.keys(BILLING_PLANS) as readonly PlanId[];
export const CREDIT_PACK_IDS = Object.keys(CREDIT_PACKS) as readonly CreditPackId[];

/** The subset of {@link BILLING_WEBHOOK_EVENTS} this project can act on. */
export const SUPPORTED_WEBHOOK_EVENTS = BILLING_WEBHOOK_EVENTS;

export const isPlanId = (value: unknown): value is PlanId =>
  typeof value === 'string' && Object.hasOwn(BILLING_PLANS, value);

export const isCreditPackId = (value: unknown): value is CreditPackId =>
  typeof value === 'string' && Object.hasOwn(CREDIT_PACKS, value);
