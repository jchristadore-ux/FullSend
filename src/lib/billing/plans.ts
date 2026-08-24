/**
 * Plan definitions and limits.
 *
 * Stripe is optional: with no key configured every account is on `free` with
 * generous limits, and the whole product still works. Turning billing on is a
 * matter of setting the keys — no code changes and no schema migration.
 */
import 'server-only';
import { env } from '../env';
import { type TenantScope } from '../db';
import { db } from '../db/repo';
import { newId, nowIso } from '../ids';
import type { PlanLimits, PlanTier, Subscription, Uuid } from '../types';

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

/**
 * With billing off, everyone gets the full product. Limits only bite once a
 * Stripe key is present, so an MVP deployment is never crippled by them.
 */
export function planLimitsFor(tier: PlanTier): PlanLimits {
  if (!env.stripe.enabled) return PLANS.agency;
  return PLANS[tier];
}

export async function subscriptionFor(
  scope: TenantScope,
  userId: Uuid,
): Promise<Subscription> {
  const existing = await db().findOne(scope, 'subscriptions', { where: { user_id: userId } });
  if (existing) return existing;

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
