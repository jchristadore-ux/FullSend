/**
 * Stripe billing: plan resolution, webhook snapshots, and one hard limit gate.
 *
 * Billing off → full product. Billing on → free limits bite; paid needs
 * active|trialing. Webhooks update the subscriptions row idempotently.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { setupContext, teardown, createProject } from './helpers';
import { db } from '@/lib/db/repo';
import { newId, nowIso } from '@/lib/ids';
import { resetStripeClient } from '@/lib/billing/stripe';
import {
  PLANS,
  planLimitsFor,
  subscriptionFor,
  tierForPriceId,
  billingEnabled,
  entitledTier,
  __setRetrieveSubscriptionForTesting,
} from '@/lib/billing/plans';
import {
  resolveTier,
  isSubscriptionLive,
  assertCanCreateProject,
  assertCanUsePosts,
} from '@/lib/billing/enforce';
import {
  applySubscriptionSnapshot,
  handleCheckoutCompleted,
  handleSubscriptionDeleted,
  handleInvoicePaymentFailed,
  handleStripeEvent,
} from '@/lib/billing/webhooks';
import { isFullSendError } from '@/lib/errors';
import type { Subscription } from '@/lib/types';

const PRICE_SEND = 'price_send_test';
const PRICE_FULL = 'price_full_send_test';
const PRICE_AGENCY = 'price_agency_test';

function enableBilling() {
  process.env.STRIPE_SECRET_KEY = 'sk_test_billing';
  process.env.STRIPE_PRICE_SEND = PRICE_SEND;
  process.env.STRIPE_PRICE_FULL_SEND = PRICE_FULL;
  process.env.STRIPE_PRICE_AGENCY = PRICE_AGENCY;
  resetStripeClient();
}

function disableBilling() {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_SEND;
  delete process.env.STRIPE_PRICE_FULL_SEND;
  delete process.env.STRIPE_PRICE_AGENCY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  resetStripeClient();
  __setRetrieveSubscriptionForTesting(null);
}

function fakeStripeSub(opts: {
  id?: string;
  customer?: string;
  status?: Stripe.Subscription.Status;
  priceId?: string;
  periodEnd?: number;
}): Stripe.Subscription {
  const priceId = opts.priceId ?? PRICE_SEND;
  return {
    id: opts.id ?? 'sub_test_1',
    object: 'subscription',
    customer: opts.customer ?? 'cus_test_1',
    status: opts.status ?? 'active',
    current_period_end: opts.periodEnd ?? Math.floor(Date.now() / 1000) + 86400 * 30,
    items: {
      object: 'list',
      data: [
        {
          id: 'si_1',
          object: 'subscription_item',
          price: { id: priceId, object: 'price' },
        } as Stripe.SubscriptionItem,
      ],
      has_more: false,
      url: '',
    },
  } as unknown as Stripe.Subscription;
}

describe('plan resolution', () => {
  afterEach(() => {
    disableBilling();
    teardown();
  });

  it('with billing off, every tier resolves to agency limits', () => {
    disableBilling();
    expect(billingEnabled()).toBe(false);
    expect(planLimitsFor('free')).toEqual(PLANS.agency);
    expect(resolveTier({ tier: 'free', status: 'active' } as Subscription)).toBe('agency');
    expect(isSubscriptionLive({ tier: 'send', status: 'canceled' } as Subscription)).toBe(true);
  });

  it('with billing on, free stays free and lapsed paid falls back to free', () => {
    enableBilling();
    expect(billingEnabled()).toBe(true);
    expect(planLimitsFor('free').posts_per_month).toBe(10);
    expect(planLimitsFor('send').posts_per_month).toBe(60);
    expect(resolveTier({ tier: 'free', status: 'active', stripe_subscription_id: null } as Subscription)).toBe('free');
    expect(
      resolveTier({
        tier: 'full_send',
        status: 'active',
        stripe_subscription_id: 'sub_live',
      } as Subscription),
    ).toBe('full_send');
    expect(
      resolveTier({
        tier: 'full_send',
        status: 'trialing',
        stripe_subscription_id: 'sub_trial',
      } as Subscription),
    ).toBe('full_send');
    expect(
      resolveTier({
        tier: 'send',
        status: 'past_due',
        stripe_subscription_id: 'sub_past',
      } as Subscription),
    ).toBe('free');
    expect(
      resolveTier({
        tier: 'agency',
        status: 'canceled',
        stripe_subscription_id: null,
      } as Subscription),
    ).toBe('free');
    expect(
      isSubscriptionLive({
        tier: 'send',
        status: 'past_due',
        stripe_subscription_id: 'sub_past',
      } as Subscription),
    ).toBe(false);
    expect(
      isSubscriptionLive({ tier: 'free', status: 'active', stripe_subscription_id: null } as Subscription),
    ).toBe(true);
  });

  it('orphan paid tier without stripe_subscription_id is free when billing is on', () => {
    enableBilling();
    const orphan = {
      tier: 'full_send',
      status: 'active',
      stripe_subscription_id: null,
    } as Subscription;
    expect(entitledTier(orphan)).toBe('free');
    expect(resolveTier(orphan)).toBe('free');
    expect(isSubscriptionLive(orphan)).toBe(false);
    expect(planLimitsFor(resolveTier(orphan)).posts_per_month).toBe(10);

    const real = {
      tier: 'full_send',
      status: 'active',
      stripe_subscription_id: 'sub_real',
    } as Subscription;
    expect(entitledTier(real)).toBe('full_send');
    expect(resolveTier(real)).toBe('full_send');
    expect(isSubscriptionLive(real)).toBe(true);
    expect(planLimitsFor(resolveTier(real)).posts_per_month).toBe(1000);
  });

  it('maps Stripe price IDs to tiers', () => {
    enableBilling();
    expect(tierForPriceId(PRICE_SEND)).toBe('send');
    expect(tierForPriceId(PRICE_FULL)).toBe('full_send');
    expect(tierForPriceId(PRICE_AGENCY)).toBe('agency');
    expect(tierForPriceId('price_unknown')).toBe('free');
  });
});

describe('webhook handlers', () => {
  beforeEach(() => {
    enableBilling();
  });
  afterEach(() => {
    disableBilling();
    teardown();
  });

  it('checkout.session.completed upgrades the subscription row', async () => {
    const ctx = await setupContext();
    const row = await subscriptionFor(ctx.scope, ctx.user.id);
    expect(row.tier).toBe('free');

    await db().update(ctx.scope, 'subscriptions', row.id, {
      stripe_customer_id: 'cus_checkout',
    });

    const stripeSub = fakeStripeSub({
      id: 'sub_from_checkout',
      customer: 'cus_checkout',
      priceId: PRICE_FULL,
      status: 'active',
    });

    const session = {
      id: 'cs_test',
      object: 'checkout.session',
      mode: 'subscription',
      customer: 'cus_checkout',
      subscription: 'sub_from_checkout',
      client_reference_id: ctx.user.id,
      metadata: { user_id: ctx.user.id, tier: 'full_send' },
    } as unknown as Stripe.Checkout.Session;

    const updated = await handleCheckoutCompleted(session, async () => stripeSub);
    expect(updated?.tier).toBe('full_send');
    expect(updated?.status).toBe('active');
    expect(updated?.stripe_subscription_id).toBe('sub_from_checkout');

    // Idempotent: applying again does not change the outcome.
    const again = await applySubscriptionSnapshot(stripeSub, {
      customerId: 'cus_checkout',
      userId: ctx.user.id,
    });
    expect(again?.tier).toBe('full_send');
    expect(again?.stripe_subscription_id).toBe('sub_from_checkout');
  });

  it('subscription.deleted and payment_failed update status', async () => {
    const ctx = await setupContext();
    const row = await subscriptionFor(ctx.scope, ctx.user.id);
    await db().update(ctx.scope, 'subscriptions', row.id, {
      tier: 'send',
      status: 'active',
      stripe_customer_id: 'cus_del',
      stripe_subscription_id: 'sub_del',
    });

    const deleted = await handleSubscriptionDeleted(
      fakeStripeSub({ id: 'sub_del', customer: 'cus_del', status: 'canceled' }),
    );
    expect(deleted?.tier).toBe('free');
    expect(deleted?.status).toBe('canceled');
    expect(deleted?.stripe_subscription_id).toBeNull();

    await db().update(ctx.scope, 'subscriptions', row.id, {
      tier: 'agency',
      status: 'active',
      stripe_customer_id: 'cus_fail',
      stripe_subscription_id: 'sub_fail',
    });

    const failed = await handleInvoicePaymentFailed({
      id: 'in_1',
      object: 'invoice',
      customer: 'cus_fail',
      subscription: 'sub_fail',
    } as unknown as Stripe.Invoice);
    expect(failed?.status).toBe('past_due');
  });

  it('handleStripeEvent dispatches known types and ignores the rest', async () => {
    const ctx = await setupContext();
    const row = await subscriptionFor(ctx.scope, ctx.user.id);
    await db().update(ctx.scope, 'subscriptions', row.id, {
      stripe_customer_id: 'cus_evt',
    });

    const sub = fakeStripeSub({
      id: 'sub_evt',
      customer: 'cus_evt',
      priceId: PRICE_SEND,
      status: 'trialing',
    });

    const result = await handleStripeEvent(
      {
        id: 'evt_1',
        type: 'customer.subscription.updated',
        data: { object: sub },
      } as unknown as Stripe.Event,
      async () => sub,
    );
    expect(result).toBe('customer.subscription.updated');

    const ignored = await handleStripeEvent(
      {
        id: 'evt_2',
        type: 'radar.early_fraud_warning.created',
        data: { object: {} },
      } as unknown as Stripe.Event,
      async () => sub,
    );
    expect(ignored.startsWith('ignored:')).toBe(true);

    const reloaded = await db().findOne(ctx.scope, 'subscriptions', {
      where: { id: row.id },
    });
    expect(reloaded?.tier).toBe('send');
    expect(reloaded?.status).toBe('trialing');
  });
});

describe('plan limit gate', () => {
  beforeEach(() => {
    enableBilling();
  });
  afterEach(() => {
    disableBilling();
    teardown();
  });

  it('blocks a second project on the free plan', async () => {
    const ctx = await setupContext();
    await subscriptionFor(ctx.scope, ctx.user.id);
    await createProject(ctx.scope, ctx.user.id);

    await expect(assertCanCreateProject(ctx.scope, ctx.user.id)).rejects.toSatisfy(
      (e: unknown) =>
        isFullSendError(e) &&
        e.code === 'plan_limit' &&
        e.status === 402 &&
        Boolean(e.remedy) &&
        (e.meta as { upgradePath?: string }).upgradePath === '/app/billing',
    );
  });

  it('does not block project creation when billing is off', async () => {
    disableBilling();
    const ctx = await setupContext();
    await createProject(ctx.scope, ctx.user.id);
    await expect(assertCanCreateProject(ctx.scope, ctx.user.id)).resolves.toBeUndefined();
  });

  it('blocks generate when the free monthly post allowance is spent', async () => {
    const ctx = await setupContext();
    await subscriptionFor(ctx.scope, ctx.user.id);
    const project = await createProject(ctx.scope, ctx.user.id);

    // Seed 10 content items this month — free cap is 10.
    const since = nowIso();
    for (let i = 0; i < 10; i++) {
      await db().insert(ctx.scope, 'content_items', {
        id: newId(),
        project_id: project.id,
        campaign_id: null,
        pillar_id: null,
        persona_id: null,
        platform: 'instagram',
        format: 'static',
        hook: `Hook ${i}`,
        script: null,
        caption: `Caption ${i}`,
        cta: 'Try it',
        hashtags: [],
        video_plan: null,
        slides: null,
        creative_asset_ids: [],
        status: 'draft',
        generation_state: 'copy_complete',
        generation_error: null,
        dedup_hash: `hash-${i}-${newId()}`,
        qc: null,
        scheduled_for: null,
        published_at: null,
        origin: 'initial',
        ai_cost_usd: 0,
        created_at: since,
        updated_at: since,
      });
    }

    await expect(
      assertCanUsePosts(ctx.scope, ctx.user.id, project.id, { action: 'generate' }),
    ).rejects.toSatisfy(
      (e: unknown) => isFullSendError(e) && e.code === 'plan_limit' && e.status === 402,
    );
  });

  it('orphan full_send without stripe_subscription_id gets free limits and self-heals', async () => {
    const ctx = await setupContext();
    const row = await subscriptionFor(ctx.scope, ctx.user.id);
    // Simulate pre-Stripe insert that claimed Full Send with no Stripe sub.
    await db().update(ctx.scope, 'subscriptions', row.id, {
      tier: 'full_send',
      status: 'active',
      stripe_subscription_id: null,
      stripe_customer_id: null,
    });

    // Pure entitlement (pre-heal) is free.
    expect(
      entitledTier({
        tier: 'full_send',
        status: 'active',
        stripe_subscription_id: null,
      }),
    ).toBe('free');

    // subscriptionFor persists the downgrade once.
    const healed = await subscriptionFor(ctx.scope, ctx.user.id);
    expect(healed.tier).toBe('free');
    expect(healed.stripe_subscription_id).toBeNull();
    expect(resolveTier(healed)).toBe('free');
    expect(planLimitsFor(resolveTier(healed)).posts_per_month).toBe(10);

    await createProject(ctx.scope, ctx.user.id);
    await expect(assertCanCreateProject(ctx.scope, ctx.user.id)).rejects.toSatisfy(
      (e: unknown) => isFullSendError(e) && e.code === 'plan_limit' && e.status === 402,
    );
  });

  it('live Stripe subscription keeps paid limits and syncs tier from price', async () => {
    const ctx = await setupContext();
    const row = await subscriptionFor(ctx.scope, ctx.user.id);
    await db().update(ctx.scope, 'subscriptions', row.id, {
      tier: 'full_send',
      status: 'active',
      stripe_subscription_id: 'sub_paid_real',
      stripe_customer_id: 'cus_paid_real',
    });

    __setRetrieveSubscriptionForTesting(async (id) => {
      expect(id).toBe('sub_paid_real');
      return fakeStripeSub({
        id: 'sub_paid_real',
        customer: 'cus_paid_real',
        priceId: PRICE_FULL,
        status: 'active',
      });
    });

    const live = await subscriptionFor(ctx.scope, ctx.user.id);
    expect(live.tier).toBe('full_send');
    expect(live.stripe_subscription_id).toBe('sub_paid_real');
    expect(resolveTier(live)).toBe('full_send');
    expect(isSubscriptionLive(live)).toBe(true);
    expect(planLimitsFor(resolveTier(live)).posts_per_month).toBe(1000);

    await createProject(ctx.scope, ctx.user.id);
    // full_send allows 1 project — second is still blocked, but not as free.
    await expect(assertCanCreateProject(ctx.scope, ctx.user.id)).rejects.toSatisfy(
      (e: unknown) =>
        isFullSendError(e) &&
        e.code === 'plan_limit' &&
        (e.meta as { kind?: string }).kind === 'projects',
    );
  });

  it('ghost stripe_subscription_id (missing in Stripe) heals to free', async () => {
    const ctx = await setupContext();
    const row = await subscriptionFor(ctx.scope, ctx.user.id);
    await db().update(ctx.scope, 'subscriptions', row.id, {
      tier: 'full_send',
      status: 'active',
      stripe_subscription_id: 'sub_ghost_missing',
      stripe_customer_id: 'cus_ghost',
      current_period_end: new Date(Date.now() + 86400_000).toISOString(),
    });

    __setRetrieveSubscriptionForTesting(async () => {
      const err = Object.assign(new Error('No such subscription: sub_ghost_missing'), {
        code: 'resource_missing',
        statusCode: 404,
        type: 'StripeInvalidRequestError',
      });
      throw err;
    });

    const healed = await subscriptionFor(ctx.scope, ctx.user.id);
    expect(healed.tier).toBe('free');
    expect(healed.status).toBe('active');
    expect(healed.stripe_subscription_id).toBeNull();
    expect(healed.current_period_end).toBeNull();
    expect(resolveTier(healed)).toBe('free');
    expect(planLimitsFor(resolveTier(healed)).posts_per_month).toBe(10);
  });

  it('canceled Stripe subscription clears ghost id to free', async () => {
    const ctx = await setupContext();
    const row = await subscriptionFor(ctx.scope, ctx.user.id);
    await db().update(ctx.scope, 'subscriptions', row.id, {
      tier: 'send',
      status: 'active',
      stripe_subscription_id: 'sub_canceled_ghost',
      stripe_customer_id: 'cus_canceled_ghost',
    });

    __setRetrieveSubscriptionForTesting(async () =>
      fakeStripeSub({
        id: 'sub_canceled_ghost',
        customer: 'cus_canceled_ghost',
        priceId: PRICE_SEND,
        status: 'canceled',
      }),
    );

    const healed = await subscriptionFor(ctx.scope, ctx.user.id);
    expect(healed.tier).toBe('free');
    expect(healed.status).toBe('active');
    expect(healed.stripe_subscription_id).toBeNull();
  });

  it('past_due Stripe subscription keeps id and maps status', async () => {
    const ctx = await setupContext();
    const row = await subscriptionFor(ctx.scope, ctx.user.id);
    await db().update(ctx.scope, 'subscriptions', row.id, {
      tier: 'agency',
      status: 'active',
      stripe_subscription_id: 'sub_past_due',
      stripe_customer_id: 'cus_past_due',
    });

    __setRetrieveSubscriptionForTesting(async () =>
      fakeStripeSub({
        id: 'sub_past_due',
        customer: 'cus_past_due',
        priceId: PRICE_AGENCY,
        status: 'past_due',
      }),
    );

    const synced = await subscriptionFor(ctx.scope, ctx.user.id);
    expect(synced.tier).toBe('agency');
    expect(synced.status).toBe('past_due');
    expect(synced.stripe_subscription_id).toBe('sub_past_due');
    expect(resolveTier(synced)).toBe('free');
    expect(isSubscriptionLive(synced)).toBe(false);
  });
});
