/**
 * Stripe customer reuse.
 *
 * One Stripe customer per FullSend user. Checkout and Portal both start from
 * the subscription row's stripe_customer_id when present.
 */
import 'server-only';
import { type TenantScope } from '../db';
import { db } from '../db/repo';
import type { Subscription, User } from '../types';
import { requireStripe } from './stripe';
import { subscriptionFor } from './plans';

export async function ensureStripeCustomer(
  scope: TenantScope,
  user: User,
): Promise<{ subscription: Subscription; customerId: string }> {
  const stripe = requireStripe();
  let subscription = await subscriptionFor(scope, user.id);

  if (subscription.stripe_customer_id) {
    return { subscription, customerId: subscription.stripe_customer_id };
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name ?? undefined,
    metadata: { fullsend_user_id: user.id },
  });

  subscription = await db().update(scope, 'subscriptions', subscription.id, {
    stripe_customer_id: customer.id,
  });

  return { subscription, customerId: customer.id };
}
