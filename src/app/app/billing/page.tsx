import { Suspense } from 'react';
import { requireSession } from '@/lib/auth/session';
import { listProjects } from '@/lib/db/repo';
import { PLANS, billingEnabled } from '@/lib/billing/plans';
import {
  loadAccess,
  postsThisMonthForUser,
  isSubscriptionLive,
} from '@/lib/billing/enforce';
import { BillingView } from '@/components/billing/BillingView';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Billing' };

export default async function BillingPage() {
  const session = await requireSession();
  const { subscription, tier, limits, billingOn } = await loadAccess(
    session.scope,
    session.user.id,
  );
  const projects = await listProjects(session.scope, session.user.id);
  const postsUsed = billingOn
    ? await postsThisMonthForUser(session.scope, session.user.id)
    : 0;

  const initial = {
    billingEnabled: billingOn || billingEnabled(),
    tier,
    status: subscription.status,
    live: isSubscriptionLive(subscription),
    plan: {
      name: PLANS[tier].name,
      priceUsd: PLANS[tier].priceUsd,
      limits,
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

  return (
    <Suspense fallback={<div className="p-8 text-dim">Loading billing…</div>}>
      <BillingView initial={initial} />
    </Suspense>
  );
}
