/**
 * Plan gating.
 *
 * When Stripe is not configured, every check is a no-op and the product runs
 * wide open. With billing on, free limits apply; paid tiers need an
 * active/trialing Stripe subscription (stripe_subscription_id present).
 */
import 'server-only';
import { type TenantScope } from '../db';
import { db, listProjects } from '../db/repo';
import { FullSendError } from '../errors';
import type { PlanLimits, PlanTier, Subscription, Uuid } from '../types';
import {
  billingEnabled,
  entitledTier,
  planLimitsFor,
  postsThisMonth,
  subscriptionFor,
} from './plans';

const PAID_OK = new Set(['active', 'trialing']);

/**
 * The tier whose limits actually apply right now.
 *
 * Delegates to entitledTier: billing off → agency; paid only with live Stripe
 * sub; otherwise free (including orphan pre-Stripe paid rows).
 */
export function resolveTier(subscription: Subscription): PlanTier {
  return entitledTier(subscription);
}

export function isSubscriptionLive(subscription: Subscription): boolean {
  if (!billingEnabled()) return true;
  if (subscription.tier === 'free') return true;
  return (
    PAID_OK.has(subscription.status) && Boolean(subscription.stripe_subscription_id)
  );
}

export function upgradeRemedy(detail?: string): string {
  return (
    detail ??
    'Open Billing to upgrade your plan, or manage your subscription in the Stripe customer portal.'
  );
}

export function planLimitError(message: string, meta: Record<string, unknown> = {}): FullSendError {
  return new FullSendError('plan_limit', message, {
    status: 402,
    remedy: upgradeRemedy(),
    meta: { ...meta, upgradePath: '/app/billing' },
  });
}

export function inactiveSubscriptionError(subscription: Subscription): FullSendError {
  return new FullSendError(
    'subscription_inactive',
    `Your ${subscription.tier} subscription is ${subscription.status}`,
    {
      status: 402,
      remedy: upgradeRemedy(
        'Update your payment method in Manage billing, or choose a plan again from Billing.',
      ),
      meta: {
        tier: subscription.tier,
        status: subscription.status,
        upgradePath: '/app/billing',
      },
    },
  );
}

export async function loadAccess(
  scope: TenantScope,
  userId: Uuid,
): Promise<{
  subscription: Subscription;
  tier: PlanTier;
  limits: PlanLimits;
  billingOn: boolean;
}> {
  const subscription = await subscriptionFor(scope, userId);
  const tier = resolveTier(subscription);
  return {
    subscription,
    tier,
    limits: planLimitsFor(tier),
    billingOn: billingEnabled(),
  };
}

/** Refuse a new project when the plan is full. */
export async function assertCanCreateProject(scope: TenantScope, userId: Uuid): Promise<void> {
  if (!billingEnabled()) return;
  const { subscription, limits, tier } = await loadAccess(scope, userId);
  if (subscription.tier !== 'free' && !isSubscriptionLive(subscription)) {
    throw inactiveSubscriptionError(subscription);
  }
  const existing = await listProjects(scope, userId);
  if (existing.length >= limits.projects) {
    throw planLimitError(
      `Your ${tier} plan includes ${limits.projects} project${limits.projects === 1 ? '' : 's'}`,
      { used: existing.length, limit: limits.projects, kind: 'projects' },
    );
  }
}

/**
 * Posts published this calendar month across every project the user owns.
 * Cap is per account, not per project.
 */
export async function postsThisMonthForUser(scope: TenantScope, userId: Uuid): Promise<number> {
  const projects = await listProjects(scope, userId);
  let total = 0;
  for (const project of projects) {
    total += await postsThisMonth(scope, project.id);
  }
  return total;
}

/** Generate / schedule / publish all consume the monthly post allowance. */
export async function assertCanUsePosts(
  scope: TenantScope,
  userId: Uuid,
  projectId: Uuid,
  opts: { action: 'generate' | 'schedule' | 'publish'; count?: number } = {
    action: 'generate',
  },
): Promise<void> {
  if (!billingEnabled()) return;
  const { subscription, limits, tier } = await loadAccess(scope, userId);
  if (subscription.tier !== 'free' && !isSubscriptionLive(subscription)) {
    throw inactiveSubscriptionError(subscription);
  }

  const used = await postsThisMonthForUser(scope, userId);
  // Also count drafts already generated this month toward generate, so free
  // cannot stockpile unlimited drafts. Published count is the hard floor;
  // content_items created this month is a soft companion for generate.
  let projected = used;
  if (opts.action === 'generate') {
    const since = new Date();
    since.setUTCDate(1);
    since.setUTCHours(0, 0, 0, 0);
    const items = await db().find(scope, 'content_items', {
      where: { project_id: projectId },
      gte: { created_at: since.toISOString() },
    });
    projected = Math.max(used, items.length);
  }

  const need = opts.count ?? 1;
  if (projected + need > limits.posts_per_month) {
    throw planLimitError(
      `Your ${tier} plan includes ${limits.posts_per_month} posts this month`,
      {
        used: projected,
        limit: limits.posts_per_month,
        kind: 'posts_per_month',
        action: opts.action,
      },
    );
  }
}
