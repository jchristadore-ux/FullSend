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
    expect(resolveTier({ tier: 'free', status: 'active' } as Subscription)).toBe('free');
    expect(resolveTier({ tier: 'full_send', status: 'active' } as Subscription)).toBe('full_send');
    expect(resolveTier({ tier: 'full_send', status: 'trialing' } as Subscription)).toBe('full_send');
    expect(resolveTier({ tier: 'send', status: 'past_due' } as Subscription)).toBe('free');
    expect(resolveTier({ tier: 'agency', status: 'canceled' } as Subscription)).toBe('free');
    expect(isSubscriptionLive({ tier: 'send', status: 'past_due' } as Subscription)).toBe(false);
    expect(isSubscriptionLive({ tier: 'free', status: 'active' } as Subscription)).toBe(true);
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
});
