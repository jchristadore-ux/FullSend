import { route } from '@/lib/api/handler';
import { listProjects } from '@/lib/db/repo';
import { PLANS } from '@/lib/billing/plans';
import {
  loadAccess,
  postsThisMonthForUser,
  isSubscriptionLive,
} from '@/lib/billing/enforce';

export const runtime = 'nodejs';

export const GET = route(async ({ session }) => {
  const { subscription, tier, limits, billingOn, unlimited } = await loadAccess(
    session.scope,
    session.user.id,
  );
  const projects = await listProjects(session.scope, session.user.id);
  const postsUsed = billingOn ? await postsThisMonthForUser(session.scope, session.user.id) : 0;

  return {
    billingEnabled: billingOn,
    tier,
    status: subscription.status,
    live: isSubscriptionLive(subscription),
    unlimited,
    plan: {
      name: unlimited ? 'Operator' : PLANS[tier].name,
      priceUsd: unlimited ? 0 : PLANS[tier].priceUsd,
      limits,
    },
    subscription: {
      tier: subscription.tier,
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end,
      hasCustomer: Boolean(subscription.stripe_customer_id),
      hasSubscription: Boolean(subscription.stripe_subscription_id),
    },
    usage: {
      projects: { used: projects.length, limit: limits.projects },
      postsThisMonth: { used: postsUsed, limit: limits.posts_per_month },
    },
    catalog: (['free', 'send', 'full_send', 'agency'] as const).map((t) => ({
      tier: t,
      name: PLANS[t].name,
      priceUsd: PLANS[t].priceUsd,
      limits: {
        projects: PLANS[t].projects,
        posts_per_month: PLANS[t].posts_per_month,
        autopilot_modes: PLANS[t].autopilot_modes,
        optimization: PLANS[t].optimization,
      },
    })),
  };
});
