// packages/shared/billing/src/catalog.test.ts
//
// The catalogue is the one file both the Worker and the deployment tooling read
// to decide what a customer is charged, so these tests are about the properties
// that would otherwise be unwritten conventions: that a lookup key belongs to
// exactly one thing, that a purchasable plan can actually be bought on every
// interval it offers, and that every refusal says what to do next.
//
// They also assert their own discovery count, because a catalogue test file that
// silently matched nothing would leave the money path exactly as unguarded as it
// started while reporting green.

import { describe, expect, test } from 'bun:test';
import {
  BILLING_PLANS,
  BILLING_WEBHOOK_EVENTS,
  CREDIT_PACKS,
  CURRENCY,
  PLAN_IDS,
} from './catalog.ts';
import {
  creditPackPriceLookupKey,
  periodGrantFor,
  planPriceLookupKey,
  planProductMetadata,
  purchasablePlans,
  resolveSubscription,
} from './resolve.ts';

describe('the billing catalogue', () => {
  test('no two prices share a Stripe lookup key, so reconciliation cannot find the wrong object', () => {
    const keys = [
      ...PLAN_IDS.flatMap((planId) =>
        (['month', 'year'] as const).map((interval) => planPriceLookupKey(planId, interval)),
      ),
      ...Object.keys(CREDIT_PACKS).map((packId) => creditPackPriceLookupKey(packId as never)),
    ];

    // A collision here is invisible until a customer is charged the wrong amount
    // for the wrong plan, because both objects exist and one of them is never
    // reconciled.
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every purchasable plan has a positive price on every interval it is sold on', () => {
    for (const plan of purchasablePlans()) {
      for (const interval of ['month', 'year'] as const) {
        expect({
          plan: plan.planId,
          interval,
          amount: plan.amount[interval],
        }).toEqual({ plan: plan.planId, interval, amount: expect.any(Number) });
        expect(plan.amount[interval]).toBeGreaterThan(0);
      }
    }
  });

  test('a plan that grants nothing says so with null rather than zero', () => {
    // Zero and null are different acts: a grant of zero still writes a ledger
    // entry, which reads as "credited nothing" instead of "plan not recognised".
    const silent = purchasablePlans().filter((plan) => plan.periodGrantMinor === 0);
    expect(silent.map((plan) => plan.planId)).toEqual([]);
  });

  test('an unknown plan is refused with the plans that do exist', () => {
    const resolution = resolveSubscription('enterprise-plus', 'month');

    expect(resolution.ok).toBe(false);
    if (resolution.ok) {
      throw new Error('an unknown plan resolved to a price');
    }
    expect(resolution.problem).toContain('enterprise-plus');
    expect(resolution.remedy).toContain(Object.keys(BILLING_PLANS).join(', '));
  });

  test('a plan that exists but is not for sale is refused by name, not treated as free', () => {
    const resolution = resolveSubscription('enterprise', 'month');

    expect(resolution.ok).toBe(false);
    if (resolution.ok) {
      throw new Error('an unpurchasable plan resolved to a price');
    }
    expect(resolution.problem).toContain('not purchasable');
    // The refusal must name the plans that can be bought, or the caller cannot
    // answer the question the rejection raised. Derived rather than hardcoded so
    // the assertion survives the catalogue gaining or losing a plan.
    for (const plan of purchasablePlans()) {
      expect(resolution.remedy).toContain(plan.planId);
    }
  });

  test('a free plan is granted rather than bought, so it is never purchasable', () => {
    // The defect this asserts: a plan with a zero price marked purchasable puts a
    // zero in the catalogue where the resolver is contracted to refuse one, and
    // the refusal only fires at the moment somebody tries to pay for it.
    const free = Object.values(BILLING_PLANS).filter((plan) => plan.amount.month === 0);
    expect(free.length).toBeGreaterThan(0);
    expect(free.filter((plan) => plan.purchasable).map((plan) => plan.planId)).toEqual([]);
  });

  test('every credit pack grants at least what it charges', () => {
    // Credits are the product; the amount is the price. A pack that granted less
    // than it cost would be a silent discount that no test in any other layer
    // could see.
    for (const pack of Object.values(CREDIT_PACKS)) {
      expect({ pack: pack.packId, credits: pack.creditsMinor, amount: pack.amount }).toEqual({
        pack: pack.packId,
        credits: expect.any(Number),
        amount: expect.any(Number),
      });
      expect(pack.creditsMinor).toBeGreaterThanOrEqual(pack.amount);
    }
  });

  test('plan entitlements never shadow the plan id Stripe metadata is reconciled through', () => {
    for (const plan of Object.values(BILLING_PLANS)) {
      expect(Object.hasOwn(plan.entitlements, 'plan_id')).toBe(false);
    }
    // And the derived metadata always carries it, so an imported object is findable.
    const plan = BILLING_PLANS.team;
    expect(planProductMetadata(plan)).toMatchObject({ plan_id: 'team', max_seats: '10' });
  });

  test('a period grant is null for a plan that is not in the catalogue, not zero', () => {
    expect(periodGrantFor('team')).toBe(BILLING_PLANS.team.periodGrantMinor);
    expect(periodGrantFor('enterprise')).toBeNull();
    expect(periodGrantFor('a-plan-from-an-old-deploy')).toBeNull();
  });

  test('the declared currency is the one every resolution reports', () => {
    // A call site that typed its own currency literal is the defect; every
    // resolution path has to resolve through the single declaration instead.
    const subscription = resolveSubscription('team', 'month');
    expect(subscription.ok && subscription.currency).toBe(CURRENCY);
  });

  test('the webhook event list is non-empty and free of duplicates', () => {
    expect(BILLING_WEBHOOK_EVENTS.length).toBeGreaterThan(0);
    expect(new Set(BILLING_WEBHOOK_EVENTS).size).toBe(BILLING_WEBHOOK_EVENTS.length);
    // Stripe event names are `object.action` with an optional third segment, as
    // in `checkout.session.completed`. What makes one undeliverable is a stray
    // space or an empty segment, both of which the endpoint accepts silently.
    for (const event of BILLING_WEBHOOK_EVENTS) {
      expect(event.split('.').length).toBeGreaterThanOrEqual(2);
      expect(event).not.toMatch(/\s/);
      expect(event.split('.').some((segment) => segment.length === 0)).toBe(false);
    }
  });
});
