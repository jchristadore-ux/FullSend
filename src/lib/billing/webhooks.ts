/**
 * Stripe webhook handlers.
 *
 * Pure enough to unit-test without the HTTP layer: pass a verified Stripe event
 * and the subscription row is updated idempotently.
 */
import 'server-only';
import type Stripe from 'stripe';
import { systemScope } from '../db';
import { db } from '../db/repo';
import { logger } from '../logger';
import { nowIso } from '../ids';
import type { PlanTier, Subscription } from '../types';
import { tierForPriceId } from './plans';

const log = logger('billing.webhook');

type SubStatus = Subscription['status'];

function mapStatus(status: Stripe.Subscription.Status): SubStatus {
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
      // incomplete / paused → treat as past_due so paid limits do not apply
      return 'past_due';
  }
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

async function findByCustomer(customerId: string): Promise<Subscription | null> {
  const scope = systemScope('stripe webhook');
  return db().findOne(scope, 'subscriptions', { where: { stripe_customer_id: customerId } });
}

async function findBySubscriptionId(subscriptionId: string): Promise<Subscription | null> {
  const scope = systemScope('stripe webhook');
  return db().findOne(scope, 'subscriptions', {
    where: { stripe_subscription_id: subscriptionId },
  });
}

async function findByUserId(userId: string): Promise<Subscription | null> {
  const scope = systemScope('stripe webhook');
  return db().findOne(scope, 'subscriptions', { where: { user_id: userId } });
}

async function patchSubscription(
  row: Subscription,
  patch: Partial<Subscription>,
): Promise<Subscription> {
  const scope = systemScope('stripe webhook');
  return db().update(scope, 'subscriptions', row.id, patch);
}

export async function applySubscriptionSnapshot(
  stripeSub: Stripe.Subscription,
  opts: { customerId?: string | null; userId?: string | null; tierHint?: PlanTier } = {},
): Promise<Subscription | null> {
  const customerId =
    opts.customerId ??
    (typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer?.id) ??
    null;

  let row =
    (await findBySubscriptionId(stripeSub.id)) ??
    (customerId ? await findByCustomer(customerId) : null) ??
    (opts.userId ? await findByUserId(opts.userId) : null);

  if (!row) {
    log.warn('no subscription row for stripe event', {
      stripeSubscriptionId: stripeSub.id,
      customerId,
      userId: opts.userId,
    });
    return null;
  }

  const priceId = priceIdFromSubscription(stripeSub);
  const tier = opts.tierHint ?? (priceId ? tierForPriceId(priceId) : row.tier);
  const status = mapStatus(stripeSub.status);

  return patchSubscription(row, {
    tier: status === 'canceled' && !priceId ? 'free' : tier,
    status: status === 'canceled' ? 'canceled' : status,
    stripe_customer_id: customerId ?? row.stripe_customer_id,
    stripe_subscription_id: stripeSub.id,
    current_period_end: periodEndIso(stripeSub),
  });
}

export async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  retrieveSubscription: (id: string) => Promise<Stripe.Subscription>,
): Promise<Subscription | null> {
  const userId =
    (session.metadata?.user_id as string | undefined) ??
    (session.client_reference_id as string | undefined) ??
    null;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const subscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id ?? null;

  if (!subscriptionId) {
    log.warn('checkout.session.completed without subscription', { sessionId: session.id });
    return null;
  }

  const stripeSub = await retrieveSubscription(subscriptionId);
  const tierMeta = session.metadata?.tier as PlanTier | undefined;
  return applySubscriptionSnapshot(stripeSub, {
    customerId,
    userId,
    tierHint: tierMeta && tierMeta !== 'free' ? tierMeta : undefined,
  });
}

export async function handleSubscriptionDeleted(
  stripeSub: Stripe.Subscription,
): Promise<Subscription | null> {
  const customerId =
    typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer?.id ?? null;
  const row =
    (await findBySubscriptionId(stripeSub.id)) ??
    (customerId ? await findByCustomer(customerId) : null);

  if (!row) return null;

  return patchSubscription(row, {
    tier: 'free',
    status: 'canceled',
    stripe_subscription_id: null,
    current_period_end: nowIso(),
  });
}

export async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
): Promise<Subscription | null> {
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  const subField = (invoice as { subscription?: string | { id: string } | null }).subscription;
  const subscriptionId =
    typeof subField === 'string' ? subField : subField?.id ?? null;

  const row =
    (subscriptionId ? await findBySubscriptionId(subscriptionId) : null) ??
    (customerId ? await findByCustomer(customerId) : null);

  if (!row) return null;

  return patchSubscription(row, {
    status: 'past_due',
  });
}

/**
 * Dispatch a verified Stripe event. Returns a short result string for logging.
 * Unknown types are ignored (200) so Stripe does not retry forever.
 */
export async function handleStripeEvent(
  event: Stripe.Event,
  retrieveSubscription: (id: string) => Promise<Stripe.Subscription>,
): Promise<string> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== 'subscription') return 'ignored_non_subscription_checkout';
      await handleCheckoutCompleted(session, retrieveSubscription);
      return 'checkout.session.completed';
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.created': {
      const sub = event.data.object as Stripe.Subscription;
      await applySubscriptionSnapshot(sub);
      return event.type;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      await handleSubscriptionDeleted(sub);
      return 'customer.subscription.deleted';
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      await handleInvoicePaymentFailed(invoice);
      return 'invoice.payment_failed';
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      const subField = (invoice as { subscription?: string | { id: string } | null }).subscription;
      const subscriptionId =
        typeof subField === 'string' ? subField : subField?.id ?? null;
      if (subscriptionId) {
        const sub = await retrieveSubscription(subscriptionId);
        await applySubscriptionSnapshot(sub);
      }
      return event.type;
    }
    default:
      return `ignored:${event.type}`;
  }
}
