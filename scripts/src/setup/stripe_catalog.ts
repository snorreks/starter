// scripts/src/setup/stripe_catalog.ts
//
// Declares the catalogue in Stripe, idempotently.
//
// Reads `@starter/billing` and makes the Stripe account agree with it. Run it
// twice and the second run changes nothing; run it after changing a price and it
// rolls the price forward rather than editing it, because a Stripe price is
// immutable and "updating" one silently continues billing the old amount to
// existing subscribers.
//
// **Plain `fetch`, not the Stripe SDK.** Three reasons, in order: the SDK is a
// large dependency that the tooling workspace would carry for six endpoints;
// its pinned version would have to be kept in step with the one the Worker uses,
// or the two would encode the API differently; and `stripe-mock` speaks the same
// REST, so this module works against the emulator and the real API with no branch.
//
// **Secrets.** The key travels in an `Authorization` header and nowhere else. It
// is never in argv, never in a log line, and never in the result this module
// returns — the caller writes ids, not credentials.

import {
  BILLING_CATALOG,
  type BillingPlan,
  type CreditPack,
  CURRENCY,
  planProductMetadata,
  purchasablePlans,
  resolveCreditPack,
  resolveSubscription,
} from '@starter/billing';

export interface StripeCredentials {
  /** Base URL, e.g. `https://api.stripe.com` or a local stripe-mock origin. */
  readonly apiBase: string;
  readonly secretKey: string;
}

/** True when this points at a local emulator rather than the Stripe API. */
export const isEmulated = (credentials: StripeCredentials): boolean => {
  try {
    const { hostname } = new URL(credentials.apiBase);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
};

/** One declared object's outcome. */
export type SyncOutcome =
  | { readonly action: 'created'; readonly name: string; readonly id: string }
  | { readonly action: 'updated'; readonly name: string; readonly id: string }
  | { readonly action: 'unchanged'; readonly name: string; readonly id: string }
  | { readonly action: 'skipped'; readonly name: string; readonly reason: string }
  | { readonly action: 'failed'; readonly name: string; readonly reason: string };

export interface SyncReport {
  readonly outcomes: readonly SyncOutcome[];
  /** True when nothing failed. */
  readonly ok: boolean;
  /** True when the target held nothing, so nothing was really provisioned. */
  readonly emulated: boolean;
}

/** A response this module understands, or a reason it does not. */
type StripeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

interface StripeProduct {
  readonly id: string;
  readonly metadata?: Record<string, string>;
  readonly name?: string;
}
interface StripePrice {
  readonly id: string;
  readonly unit_amount?: number | null;
  readonly unit_amount_decimal?: string | null;
  readonly active?: boolean;
  readonly lookup_key?: string | null;
}

const request = async <T>(
  credentials: StripeCredentials,
  path: string,
  init: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
  fetcher: typeof fetch,
): Promise<StripeResult<T>> => {
  const url = `${credentials.apiBase.replace(/\/$/, '')}${path}`;
  const response = await fetcher(url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${credentials.secretKey}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
    },
    // A redirect would replay the bearer header against another host. `manual` is
    // the only setting that makes that impossible.
    redirect: 'manual',
    ...(init.body === undefined
      ? {}
      : { body: new URLSearchParams(flatten(init.body)).toString() }),
  });

  if (!response.ok) {
    // The response body carries Stripe's own error text, which names the field it
    // rejected. Surfacing the status alone would make a bad lookup_key and a bad
    // product id indistinguishable.
    const detail = (await response.text().catch(() => '')).slice(0, 300).trim();
    return { ok: false, reason: `HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}` };
  }
  return { ok: true, value: (await response.json()) as T };
};

/** Stripe takes form encoding, including for arrays, which JSON does not describe. */
const flatten = (body: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(body).flatMap(([key, value]) => {
      if (value === undefined || value === null) {
        return [];
      }
      if (typeof value === 'object' && !Array.isArray(value)) {
        return Object.entries(value as Record<string, unknown>).map(([inner, innerValue]) => [
          `${key}[${inner}]`,
          String(innerValue),
        ]);
      }
      if (Array.isArray(value)) {
        return value.map((entry, index) => [`${key}[${index}]`, String(entry)]);
      }
      return [[key, String(value)]];
    }),
  );

const listProducts = async (
  credentials: StripeCredentials,
  fetcher: typeof fetch,
): Promise<StripeResult<StripeProduct[]>> => {
  const products: StripeProduct[] = [];
  let cursor: string | undefined;
  while (true) {
    const result = await request<{ data?: unknown; has_more?: boolean }>(
      credentials,
      `/v1/products?limit=100&active=true${cursor === undefined ? '' : `&starting_after=${encodeURIComponent(cursor)}`}`,
      { method: 'GET' },
      fetcher,
    );
    if (!result.ok) {
      return result;
    }
    const { data, has_more } = result.value;
    if (!Array.isArray(data)) {
      return { ok: false, reason: 'Stripe returned a product list without data.' };
    }
    products.push(...(data as StripeProduct[]));
    if (!has_more) {
      return { ok: true, value: products };
    }
    const next = (data.at(-1) as StripeProduct | undefined)?.id;
    if (typeof next !== 'string' || next.length === 0 || next === cursor) {
      return { ok: false, reason: 'Stripe returned a product page without a next cursor.' };
    }
    cursor = next;
  }
};

const findPriceByLookupKey = async (
  credentials: StripeCredentials,
  lookupKey: string,
  fetcher: typeof fetch,
): Promise<StripeResult<StripePrice | null>> => {
  const result = await request<{ data?: unknown }>(
    credentials,
    `/v1/prices?limit=100&active=true&lookup_keys[]=${encodeURIComponent(lookupKey)}`,
    { method: 'GET' },
    fetcher,
  );
  if (!result.ok) {
    return result;
  }
  const { data } = result.value;
  if (!Array.isArray(data)) {
    return { ok: false, reason: 'Stripe returned a price list without data.' };
  }
  const matches = (data as StripePrice[]).filter((price) => price.lookup_key === lookupKey);
  if (matches.length > 1) {
    // Two live prices under one lookup key means a previous roll-forward did not
    // archive its predecessor, and a customer could be billed either amount.
    return { ok: false, reason: `Two active prices share lookup key "${lookupKey}".` };
  }
  return { ok: true, value: matches[0] ?? null };
};

/**
 * One subscription price, created or rolled forward.
 *
 * A differing amount is never an update: Stripe prices cannot be changed, so the
 * old one is archived and a new one created. Existing subscribers keep the price
 * they subscribed at, which is the correct behaviour and the reason this is
 * reported as `created` rather than `updated`.
 */
const syncSubscriptionPrice = async (
  credentials: StripeCredentials,
  productId: string,
  plan: BillingPlan,
  interval: 'month' | 'year',
  dryRun: boolean,
  fetcher: typeof fetch,
): Promise<SyncOutcome> => {
  const resolved = resolveSubscription(plan.planId, interval);
  if (!resolved.ok) {
    return { action: 'skipped', name: `${plan.name} (${interval}ly)`, reason: resolved.problem };
  }
  const { lookupKey, amount } = resolved;
  const name = `${plan.name} (${interval}ly)`;

  const existing = await findPriceByLookupKey(credentials, lookupKey, fetcher);
  if (!existing.ok) {
    return { action: 'failed', name, reason: existing.reason };
  }
  if (existing.value !== null && existing.value.unit_amount === amount) {
    return { action: 'unchanged', name, id: existing.value.id };
  }

  if (dryRun) {
    return {
      action: 'skipped',
      name,
      reason:
        existing.value === null
          ? 'would create'
          : `would replace ${existing.value.id} (amounts are immutable in Stripe)`,
    };
  }

  const created = await request<{ id?: unknown }>(
    credentials,
    '/v1/prices',
    {
      method: 'POST',
      body: {
        product: productId,
        unit_amount: amount,
        currency: CURRENCY,
        recurring: { interval, usage_type: 'licensed' },
        lookup_key: lookupKey,
        transfer_lookup_key: true,
        metadata: { plan_id: plan.planId },
      },
    },
    fetcher,
  );
  if (!created.ok || typeof created.value.id !== 'string') {
    return {
      action: 'failed',
      name,
      reason: created.ok ? 'Stripe returned no price id.' : created.reason,
    };
  }

  // Archive the predecessor. Without this a lookup key would resolve to whichever
  // price the API listed first, and the two amounts would be indistinguishable.
  if (existing.value !== null) {
    const archived = await request(
      credentials,
      `/v1/prices/${existing.value.id}`,
      { method: 'POST', body: { active: false } },
      fetcher,
    );
    if (!archived.ok) {
      return {
        action: 'failed',
        name,
        reason: `created ${created.value.id} but could not archive ${existing.value.id}: ${archived.reason}`,
      };
    }
  }

  return { action: 'created', name, id: created.value.id };
};

const syncCreditPrice = async (
  credentials: StripeCredentials,
  productId: string,
  pack: CreditPack,
  dryRun: boolean,
  fetcher: typeof fetch,
): Promise<SyncOutcome> => {
  const resolved = resolveCreditPack(pack.packId);
  if (!resolved.ok) {
    return { action: 'skipped', name: pack.name, reason: resolved.problem };
  }
  const { lookupKey, amount } = resolved;
  const name = pack.name;

  const existing = await findPriceByLookupKey(credentials, lookupKey, fetcher);
  if (!existing.ok) {
    return { action: 'failed', name, reason: existing.reason };
  }
  if (existing.value !== null && existing.value.unit_amount === amount) {
    return { action: 'unchanged', name, id: existing.value.id };
  }
  if (dryRun) {
    return {
      action: 'skipped',
      name,
      reason: existing.value === null ? 'would create' : 'would replace',
    };
  }

  const created = await request<{ id?: unknown }>(
    credentials,
    '/v1/prices',
    {
      method: 'POST',
      body: {
        product: productId,
        unit_amount: amount,
        currency: CURRENCY,
        lookup_key: lookupKey,
        transfer_lookup_key: true,
        metadata: { pack_id: pack.packId },
      },
    },
    fetcher,
  );
  if (!created.ok || typeof created.value.id !== 'string') {
    return {
      action: 'failed',
      name,
      reason: created.ok ? 'Stripe returned no price id.' : created.reason,
    };
  }
  if (existing.value !== null) {
    const archived = await request(
      credentials,
      `/v1/prices/${existing.value.id}`,
      { method: 'POST', body: { active: false } },
      fetcher,
    );
    if (!archived.ok) {
      return {
        action: 'failed',
        name,
        reason: `created ${created.value.id} but could not archive ${existing.value.id}: ${archived.reason}`,
      };
    }
  }
  return { action: 'created', name, id: created.value.id };
};

/**
 * Make the account match the catalogue.
 *
 * Order matters and is stated rather than incidental: products before prices,
 * because a price names a product; subscriptions before credit packs, because the
 * plans are what a checkout is created against.
 *
 * Every failure is collected rather than thrown, so one rejected price does not
 * hide the state of the other four. The caller decides the exit code from `ok`.
 */
export const syncStripeCatalog = async (
  credentials: StripeCredentials,
  options: { dryRun?: boolean; fetcher?: typeof fetch } = {},
): Promise<SyncReport> => {
  const dryRun = options.dryRun === true;
  const fetcher = options.fetcher ?? fetch;
  const outcomes: SyncOutcome[] = [];

  const products = await listProducts(credentials, fetcher);
  if (!products.ok) {
    return {
      outcomes: [{ action: 'failed', name: 'products', reason: products.reason }],
      ok: false,
      emulated: isEmulated(credentials),
    };
  }

  for (const plan of purchasablePlans()) {
    const name = `${plan.name} plan`;
    const existing = products.value.find((product) => product.metadata?.plan_id === plan.planId);

    let productId = existing?.id;
    if (productId === undefined) {
      if (dryRun) {
        outcomes.push({ action: 'skipped', name, reason: 'would create the product' });
        continue;
      }
      const created = await request<{ id?: unknown }>(
        credentials,
        '/v1/products',
        {
          method: 'POST',
          body: {
            name: plan.name,
            description: plan.description,
            metadata: planProductMetadata(plan),
          },
        },
        fetcher,
      );
      if (!created.ok || typeof created.value.id !== 'string') {
        outcomes.push({
          action: 'failed',
          name,
          reason: created.ok ? 'Stripe returned no product id.' : created.reason,
        });
        continue;
      }
      productId = created.value.id;
      outcomes.push({ action: 'created', name, id: productId });
    } else {
      outcomes.push({ action: 'unchanged', name, id: productId });
    }

    for (const interval of ['month', 'year'] as const) {
      outcomes.push(
        await syncSubscriptionPrice(credentials, productId, plan, interval, dryRun, fetcher),
      );
    }
  }

  // Unpurchasable plans are reported, never created. A `continue` here would be a
  // silent skip; the line below is the difference between "the catalogue has one
  // plan you cannot buy yet" and a run that looks complete.
  for (const plan of Object.values(BILLING_CATALOG.plans).filter((entry) => !entry.purchasable)) {
    outcomes.push({
      action: 'skipped',
      name: `${plan.name} plan`,
      reason: 'not purchasable; no product or price is created for it',
    });
  }

  const creditProductName = 'Credit packs';
  let creditProductId = products.value.find(
    (product) => product.metadata?.pack_id === 'credits',
  )?.id;
  if (creditProductId === undefined) {
    if (dryRun) {
      outcomes.push({
        action: 'skipped',
        name: creditProductName,
        reason: 'would create the product',
      });
    } else {
      const created = await request<{ id?: unknown }>(
        credentials,
        '/v1/products',
        {
          method: 'POST',
          body: {
            name: 'Credit packs',
            description: 'Prepaid usage credits.',
            metadata: { pack_id: 'credits' },
          },
        },
        fetcher,
      );
      if (!created.ok || typeof created.value.id !== 'string') {
        outcomes.push({
          action: 'failed',
          name: creditProductName,
          reason: created.ok ? 'Stripe returned no product id.' : created.reason,
        });
      } else {
        creditProductId = created.value.id;
        outcomes.push({ action: 'created', name: creditProductName, id: creditProductId });
      }
    }
  } else {
    outcomes.push({ action: 'unchanged', name: creditProductName, id: creditProductId });
  }

  if (creditProductId !== undefined) {
    for (const pack of Object.values(BILLING_CATALOG.creditPacks)) {
      outcomes.push(await syncCreditPrice(credentials, creditProductId, pack, dryRun, fetcher));
    }
  }

  return {
    outcomes,
    ok: outcomes.every((outcome) => outcome.action !== 'failed'),
    emulated: isEmulated(credentials),
  };
};

export interface WebhookSyncOptions {
  /** The URL Stripe will POST to. Required: a local run has no public origin. */
  readonly url: string;
  readonly dryRun?: boolean;
  readonly fetcher?: typeof fetch;
}

/**
 * Point a webhook endpoint at this deployment.
 *
 * Separate from the catalogue sync and explicitly opt-in, because a webhook
 * endpoint needs a public origin and neither `localhost` nor a dev port is one.
 * Reporting "webhook endpoint not configured" is a fact; quietly skipping it would
 * make a completed run look like a configured one.
 */
export const syncWebhookEndpoint = async (
  credentials: StripeCredentials,
  options: WebhookSyncOptions,
): Promise<SyncOutcome> => {
  const fetcher = options.fetcher ?? fetch;
  const name = `webhook endpoint (${options.url})`;

  const listed = await request<{ data?: unknown }>(
    credentials,
    '/v1/webhook_endpoints',
    { method: 'GET' },
    fetcher,
  );
  if (!listed.ok) {
    return { action: 'failed', name, reason: listed.reason };
  }
  const existing = Array.isArray(listed.value.data)
    ? (listed.value.data as { id: string; url?: string }[]).find(
        (endpoint) => endpoint.url === options.url,
      )
    : undefined;

  if (existing !== undefined) {
    if (options.dryRun === true) {
      return { action: 'unchanged', name, id: existing.id };
    }
    const updated = await request(
      credentials,
      `/v1/webhook_endpoints/${existing.id}`,
      { method: 'POST', body: { enabled_events: [...BILLING_CATALOG.webhookEvents] } },
      fetcher,
    );
    return updated.ok
      ? { action: 'updated', name, id: existing.id }
      : { action: 'failed', name, reason: updated.reason };
  }

  if (options.dryRun === true) {
    return { action: 'skipped', name, reason: 'would create' };
  }

  const created = await request<{ id?: unknown; secret?: unknown }>(
    credentials,
    '/v1/webhook_endpoints',
    {
      method: 'POST',
      body: { url: options.url, enabled_events: [...BILLING_CATALOG.webhookEvents] },
    },
    fetcher,
  );
  if (!created.ok || typeof created.value.id !== 'string') {
    return {
      action: 'failed',
      name,
      reason: created.ok ? 'Stripe returned no endpoint id.' : created.reason,
    };
  }
  // The signing secret is returned exactly once and is never printed here. It
  // reaches the Worker through the deployment's secret channel, not through a log.
  return { action: 'created', name, id: created.value.id };
};
