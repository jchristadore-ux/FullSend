/**
 * Plan definitions and limits.
 *
 * Stripe is optional: with no key configured every account gets the full
 * product. Turning billing on is a matter of setting the keys — no code
 * changes and no schema migration.
 *
 * When billing is on, paid tiers (send / full_send / agency) only entitle if
 * status is active|trialing AND stripe_subscription_id is present. Orphan
 * rows (paid tier, null Stripe sub) and ghost ids (stale/deleted Stripe
 * subscriptions) are treated as free and self-healed on read.
 */
import 'server-only';
import type Stripe from 'stripe';
import { env } from '../env';
import { type TenantScope } from '../db';
import { db } from '../db/repo';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import type { PlanLimits, PlanTier, Subscription, Uuid } from '../types';
import { requireStripe } from './stripe';

const log = logger('billing.plans');

export const PLANS: Record<PlanTier, PlanLimits & { name: string; priceUsd: number }> = {
  free: {
    name: 'Free',
    priceUsd: 0,
    projects: 1,
    posts_per_month: 10,
    platforms: ['instagram', 'tiktok'],
    autopilot_modes: ['manual'],
    optimization: false,
  },
  send: {
    name: 'Send',
    priceUsd: 29,
    projects: 1,
    posts_per_month: 60,
    platforms: ['instagram', 'tiktok'],
    autopilot_modes: ['manual', 'hybrid'],
    optimization: false,
  },
  full_send: {
    name: 'Full Send',
    priceUsd: 79,
    projects: 1,
    posts_per_month: 1000,
    platforms: ['instagram', 'tiktok'],
    autopilot_modes: ['manual', 'hybrid', 'full_send'],
    optimization: true,
  },
  agency: {
    name: 'Agency',
    priceUsd: 249,
    projects: 10,
    posts_per_month: 10_000,
    platforms: ['instagram', 'tiktok'],
    autopilot_modes: ['manual', 'hybrid', 'full_send'],
    optimization: true,
  },
};

const PAID_TIERS = new Set<PlanTier>(['send', 'full_send', 'agency']);
const LIVE_STATUSES = new Set(['active', 'trialing']);
const TERMINAL_STRIPE_STATUSES = new Set<Stripe.Subscription.Status>([
  'canceled',
  'incomplete_expired',
]);

type RetrieveSubscription = (id: string) => Promise<Stripe.Subscription>;

/** Test seam — inject Stripe.subscriptions.retrieve without hitting the network. */
let retrieveSubscriptionForTesting: RetrieveSubscription | null = null;

export function __setRetrieveSubscriptionForTesting(fn: RetrieveSubscription | null): void {
  retrieveSubscriptionForTesting = fn;
}

/**
 * With billing off, everyone gets the full product. Limits only bite once a
 * Stripe key is present, so an MVP deployment is never crippled by them.
 */
export function planLimitsFor(tier: PlanTier): PlanLimits {
  if (!env.stripe.enabled) return PLANS.agency;
  return PLANS[tier];
}

/**
 * Tier that actually grants limits / UI display.
 *
 * Billing off → agency (full product). Billing on → paid only when status is
 * active|trialing and a Stripe subscription id is present; otherwise free.
 */
export function entitledTier(
  subscription: Pick<Subscription, 'tier' | 'status' | 'stripe_subscription_id'>,
): PlanTier {
  if (!billingEnabled()) return 'agency';
  if (subscription.tier === 'free') return 'free';
  if (
    PAID_TIERS.has(subscription.tier) &&
    LIVE_STATUSES.has(subscription.status) &&
    Boolean(subscription.stripe_subscription_id)
  ) {
    return subscription.tier;
  }
  return 'free';
}

/** True when the row claims a paid tier but has no Stripe subscription. */
export function isOrphanPaidSubscription(
  subscription: Pick<Subscription, 'tier' | 'stripe_subscription_id'>,
): boolean {
  return PAID_TIERS.has(subscription.tier) && !subscription.stripe_subscription_id;
}

function isMissingSubscriptionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; statusCode?: number; type?: string; message?: string };
  if (e.code === 'resource_missing') return true;
  if (e.statusCode === 404) return true;
  if (typeof e.message === 'string' && /no such subscription/i.test(e.message)) return true;
  return false;
}

function priceIdFromSubscription(sub: Stripe.Subscription): string | null {
  const item = sub.items?.data?.[0];
  const price = item?.price;
  if (!price) return null;
  return typeof price === 'string' ? price : price.id;
}

function periodEndIso(sub: Stripe.Subscription): string | null {
  const end = (sub as { current_period_end?: number }).current_period_end;
  if (!end) return null;
  return new Date(end * 1000).toISOString();
}

/** Map Stripe status → our subscription status (mirrors webhooks.mapStatus). */
function mapStripeStatus(status: Stripe.Subscription.Status): Subscription['status'] {
  switch (status) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'past_due';
  }
}

async function clearToFree(scope: TenantScope, subscription: Subscription): Promise<Subscription> {
  return db().update(scope, 'subscriptions', subscription.id, {
    tier: 'free',
    status: 'active',
    stripe_subscription_id: null,
    current_period_end: null,
  });
}

async function retrieveStripeSubscription(id: string): Promise<Stripe.Subscription> {
  if (retrieveSubscriptionForTesting) return retrieveSubscriptionForTesting(id);
  return requireStripe().subscriptions.retrieve(id);
}

/**
 * Persist-on-read normalization when billing is on:
 * - paid tier + null stripe_subscription_id → free (orphan heal)
 * - stripe_subscription_id set → retrieve from Stripe and heal ghosts /
 *   sync live status (one retrieve per billing/status load; no cache yet)
 */
async function normalizeSubscription(
  scope: TenantScope,
  subscription: Subscription,
): Promise<Subscription> {
  if (!billingEnabled()) return subscription;

  if (isOrphanPaidSubscription(subscription)) {
    return clearToFree(scope, subscription);
  }

  const subId = subscription.stripe_subscription_id;
  if (!subId) return subscription;

  // Fine to retrieve on each billing/status load for now (no short-TTL cache).
  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await retrieveStripeSubscription(subId);
  } catch (err) {
    if (isMissingSubscriptionError(err)) {
      log.info('clearing ghost stripe_subscription_id (missing in Stripe)', {
        subscriptionId: subscription.id,
        stripeSubscriptionId: subId,
      });
      return clearToFree(scope, subscription);
    }
    log.warn('stripe.subscriptions.retrieve failed; leaving row unchanged', {
      subscriptionId: subscription.id,
      stripeSubscriptionId: subId,
      error: err instanceof Error ? err.message : String(err),
    });
    return subscription;
  }

  if (TERMINAL_STRIPE_STATUSES.has(stripeSub.status)) {
    log.info('clearing stripe_subscription_id (terminal Stripe status)', {
      subscriptionId: subscription.id,
      stripeSubscriptionId: subId,
      stripeStatus: stripeSub.status,
    });
    return clearToFree(scope, subscription);
  }

  const mappedStatus = mapStripeStatus(stripeSub.status);
  const priceId = priceIdFromSubscription(stripeSub);
  const periodEnd = periodEndIso(stripeSub);

  // Keep paid tier on past_due/unpaid; sync tier from price when live.
  let patchTier = subscription.tier;
  if (LIVE_STATUSES.has(mappedStatus) && priceId) {
    const fromPrice = tierForPriceId(priceId);
    if (fromPrice !== 'free') patchTier = fromPrice;
  }

  if (
    patchTier === subscription.tier &&
    mappedStatus === subscription.status &&
    (periodEnd ?? null) === (subscription.current_period_end ?? null) &&
    subscription.stripe_subscription_id === stripeSub.id
  ) {
    return subscription;
  }

  return db().update(scope, 'subscriptions', subscription.id, {
    tier: patchTier,
    status: mappedStatus,
    stripe_subscription_id: stripeSub.id,
    current_period_end: periodEnd,
  });
}

/**
 * Load (or create) the subscriptions row, self-healing orphan / ghost paid
 * tiers when billing is enabled.
 */
export async function subscriptionFor(
  scope: TenantScope,
  userId: Uuid,
): Promise<Subscription> {
  const existing = await db().findOne(scope, 'subscriptions', { where: { user_id: userId } });
  if (existing) return normalizeSubscription(scope, existing);

  return db().insert(scope, 'subscriptions', {
    id: newId(),
    user_id: userId,
    tier: env.stripe.enabled ? 'free' : 'full_send',
    status: 'active',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    current_period_end: null,
    created_at: nowIso(),
  });
}

/** Alias kept for call sites that want the effective (normalized) row. */
export const effectiveSubscription = subscriptionFor;

export function priceIdFor(tier: PlanTier): string | undefined {
  switch (tier) {
    case 'send':
      return env.stripe.priceSend;
    case 'full_send':
      return env.stripe.priceFullSend;
    case 'agency':
      return env.stripe.priceAgency;
    default:
      return undefined;
  }
}

export function tierForPriceId(priceId: string): PlanTier {
  if (priceId === env.stripe.priceSend) return 'send';
  if (priceId === env.stripe.priceFullSend) return 'full_send';
  if (priceId === env.stripe.priceAgency) return 'agency';
  return 'free';
}

/** Posts published this calendar month, for the plan cap. */
export async function postsThisMonth(scope: TenantScope, projectId: Uuid): Promise<number> {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const posts = await db().find(scope, 'published_posts', {
    where: { project_id: projectId },
    gte: { published_at: since.toISOString() },
  });
  return posts.length;
}

export function billingEnabled(): boolean {
  return env.stripe.enabled;
}
