/**
 * Stripe client. Constructed lazily so deployments without billing never load
 * the SDK path that needs a secret key.
 */
import 'server-only';
import Stripe from 'stripe';
import { env } from '../env';
import { FullSendError } from '../errors';

let client: Stripe | null = null;

export function requireStripe(): Stripe {
  if (!env.stripe.enabled || !env.stripe.secretKey) {
    throw new FullSendError('billing_disabled', 'Billing is not configured on this deployment', {
      status: 503,
      remedy: 'Ask the operator to set STRIPE_SECRET_KEY, or use the product without paid plans.',
    });
  }
  if (!client) {
    client = new Stripe(env.stripe.secretKey, {
      apiVersion: '2025-10-29.clover',
      typescript: true,
    });
  }
  return client;
}

/** Test seam — clears the cached client between cases. */
export function resetStripeClient(): void {
  client = null;
}
