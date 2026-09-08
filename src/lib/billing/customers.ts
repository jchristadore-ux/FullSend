/**
 * Stripe customer reuse.
 *
 * One Stripe customer per FullSend user. Checkout and Portal both start from
 * the subscription row's stripe_customer_id when present.
 *
 * After a TEST→LIVE key switch (or any orphaned cus_ id), the stored id may
 * not exist under the current Stripe key. We retrieve before reuse and heal
 * on resource_missing so checkout/portal do not 500.
 */
import 'server-only';
import type Stripe from 'stripe';
import { type TenantScope } from '../db';
import { db } from '../db/repo';
import { logger } from '../logger';
import type { Subscription, User } from '../types';
import { requireStripe } from './stripe';
import { subscriptionFor } from './plans';

const log = logger('billing.customers');

type RetrieveCustomer = (id: string) => Promise<Stripe.Customer | Stripe.DeletedCustomer>;
type CreateCustomer = (params: Stripe.CustomerCreateParams) => Promise<Stripe.Customer>;

/** Test seam — inject Stripe.customers.retrieve without hitting the network. */
let retrieveCustomerForTesting: RetrieveCustomer | null = null;
/** Test seam — inject Stripe.customers.create without hitting the network. */
let createCustomerForTesting: CreateCustomer | null = null;

export function __setRetrieveCustomerForTesting(fn: RetrieveCustomer | null): void {
  retrieveCustomerForTesting = fn;
}

export function __setCreateCustomerForTesting(fn: CreateCustomer | null): void {
  createCustomerForTesting = fn;
}

function isMissingCustomerError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; statusCode?: number; message?: string };
  if (e.code === 'resource_missing') return true;
  if (e.statusCode === 404) return true;
  if (typeof e.message === 'string' && /no such customer/i.test(e.message)) return true;
  return false;
}

async function retrieveCustomer(id: string): Promise<Stripe.Customer | Stripe.DeletedCustomer> {
  if (retrieveCustomerForTesting) return retrieveCustomerForTesting(id);
  return requireStripe().customers.retrieve(id);
}

async function createCustomer(params: Stripe.CustomerCreateParams): Promise<Stripe.Customer> {
  if (createCustomerForTesting) return createCustomerForTesting(params);
  return requireStripe().customers.create(params);
}

/**
 * Clear a customer id that does not exist under the current Stripe key.
 * If a stripe_subscription_id was tied to that missing customer, it cannot be
 * valid under this key either (typical TEST→LIVE leftover) — clear it so it
 * does not poison entitlement. Do not invent a wipe of a verified live sub.
 */
async function clearGhostCustomer(
  scope: TenantScope,
  subscription: Subscription,
  missingCustomerId: string,
): Promise<Subscription> {
  log.info('clearing ghost stripe_customer_id (missing under current Stripe key)', {
    subscriptionId: subscription.id,
    stripeCustomerId: missingCustomerId,
    hadSubscriptionId: Boolean(subscription.stripe_subscription_id),
  });

  const patch: Partial<Subscription> = {
    stripe_customer_id: null,
  };
  if (subscription.stripe_subscription_id) {
    patch.stripe_subscription_id = null;
    patch.current_period_end = null;
    patch.tier = 'free';
    patch.status = 'active';
  }

  return db().update(scope, 'subscriptions', subscription.id, patch);
}

export async function ensureStripeCustomer(
  scope: TenantScope,
  user: User,
): Promise<{ subscription: Subscription; customerId: string }> {
  requireStripe();
  let subscription = await subscriptionFor(scope, user.id);

  if (subscription.stripe_customer_id) {
    const existingId = subscription.stripe_customer_id;
    try {
      const existing = await retrieveCustomer(existingId);
      if (!('deleted' in existing && existing.deleted)) {
        return { subscription, customerId: existingId };
      }
      // Soft-deleted in Stripe — treat as missing and recreate.
      subscription = await clearGhostCustomer(scope, subscription, existingId);
    } catch (err) {
      if (!isMissingCustomerError(err)) throw err;
      subscription = await clearGhostCustomer(scope, subscription, existingId);
    }
  }

  const customer = await createCustomer({
    email: user.email,
    name: user.name ?? undefined,
    metadata: { fullsend_user_id: user.id },
  });

  subscription = await db().update(scope, 'subscriptions', subscription.id, {
    stripe_customer_id: customer.id,
  });

  return { subscription, customerId: customer.id };
}
