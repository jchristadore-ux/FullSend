/**
 * Acquire.com data-room metrics for the Control Room.
 *
 * Every figure is counted from the live database (and Stripe subscription rows
 * already synced into `subscriptions`). Nothing here is estimated, projected,
 * or invented — a zero is a real zero.
 */
import 'server-only';
import { systemScope } from '../db';
import { db } from '../db/repo';
import { PLANS } from '../billing/plans';
import type { PlanTier } from '../types';
import { queueStats } from '../jobs/runner';

export interface AcquireMetrics {
  signups: number;
  /** Users who own at least one project with a product analysis. */
  activated: number;
  activationRate: number | null;
  /** Distinct users with at least one published post. */
  firstPublishUsers: number;
  firstPublishRate: number | null;
  publishVolume: number;
  jobSuccessRate: number | null;
  jobsSucceeded: number;
  jobsFailed: number;
  jobsDead: number;
  /** Monthly recurring revenue in USD from active/trialing Stripe-backed rows. */
  mrrUsd: number;
  payingCustomers: number;
  measuredAt: string;
}

function isPaying(status: string, stripeSubId: string | null, tier: string): boolean {
  if (!stripeSubId) return false;
  if (status !== 'active' && status !== 'trialing') return false;
  return tier !== 'free';
}

export async function loadAcquireMetrics(): Promise<AcquireMetrics> {
  const scope = systemScope('acquire metrics');
  const [users, projects, analyses, published, subscriptions, queue] = await Promise.all([
    db().find(scope, 'users', {}),
    db().find(scope, 'projects', {}),
    db().find(scope, 'product_analysis', {}),
    db().find(scope, 'published_posts', {}),
    db().find(scope, 'subscriptions', {}),
    queueStats(),
  ]);

  const projectOwner = new Map(projects.map((p) => [p.id, p.user_id]));
  const activatedUsers = new Set<string>();
  for (const a of analyses) {
    const owner = projectOwner.get(a.project_id);
    if (owner) activatedUsers.add(owner);
  }

  const firstPublishUsers = new Set<string>();
  for (const post of published) {
    const owner = projectOwner.get(post.project_id);
    if (owner) firstPublishUsers.add(owner);
  }

  const jobsSucceeded = queue.succeeded;
  const jobsFailed = queue.failed;
  const jobsDead = queue.dead;
  const finished = jobsSucceeded + jobsFailed + jobsDead;
  const jobSuccessRate = finished === 0 ? null : jobsSucceeded / finished;

  let mrrUsd = 0;
  let payingCustomers = 0;
  for (const sub of subscriptions) {
    if (!isPaying(sub.status, sub.stripe_subscription_id, sub.tier)) continue;
    const plan = PLANS[sub.tier as PlanTier];
    if (!plan || plan.priceUsd <= 0) continue;
    mrrUsd += plan.priceUsd;
    payingCustomers += 1;
  }

  const signups = users.length;
  const activated = activatedUsers.size;
  const firstPublish = firstPublishUsers.size;

  return {
    signups,
    activated,
    activationRate: signups === 0 ? null : activated / signups,
    firstPublishUsers: firstPublish,
    firstPublishRate: signups === 0 ? null : firstPublish / signups,
    publishVolume: published.length,
    jobSuccessRate,
    jobsSucceeded,
    jobsFailed,
    jobsDead,
    mrrUsd,
    payingCustomers,
    measuredAt: new Date().toISOString(),
  };
}
