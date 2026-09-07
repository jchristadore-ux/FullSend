import { z } from 'zod';
import { route, LIMITS } from '@/lib/api/handler';
import { FullSendError } from '@/lib/errors';
import { env } from '@/lib/env';
import { billingEnabled, priceIdFor } from '@/lib/billing/plans';
import { ensureStripeCustomer } from '@/lib/billing/customers';
import { requireStripe } from '@/lib/billing/stripe';
import type { PlanTier } from '@/lib/types';

export const runtime = 'nodejs';

const bodySchema = z.object({
  tier: z.enum(['send', 'full_send', 'agency']),
});

export const POST = route(
  async ({ session, body }) => {
    if (!billingEnabled()) {
      throw new FullSendError('billing_disabled', 'Billing is not configured on this deployment', {
        status: 503,
        remedy: 'Paid plans are unavailable until Stripe is configured.',
      });
    }

    const tier = body.tier as Exclude<PlanTier, 'free'>;
    const priceId = priceIdFor(tier);
    if (!priceId) {
      throw new FullSendError(
        'price_not_configured',
        `No Stripe price ID is configured for the ${tier} plan`,
        {
          status: 503,
          remedy: 'Set STRIPE_PRICE_SEND / STRIPE_PRICE_FULL_SEND / STRIPE_PRICE_AGENCY and redeploy.',
        },
      );
    }

    const stripe = requireStripe();
    const { customerId } = await ensureStripeCustomer(session.scope, session.user);

    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: session.user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${env.appUrl}/app/billing?checkout=success`,
      cancel_url: `${env.appUrl}/app/billing?checkout=cancel`,
      allow_promotion_codes: true,
      metadata: {
        user_id: session.user.id,
        tier,
      },
      subscription_data: {
        metadata: {
          user_id: session.user.id,
          tier,
        },
      },
    });

    if (!checkout.url) {
      throw new FullSendError('checkout_failed', 'Stripe did not return a Checkout URL', {
        status: 502,
        remedy: 'Try again in a moment. If it keeps failing, check the Stripe Dashboard logs.',
        retryable: true,
      });
    }

    return { url: checkout.url, sessionId: checkout.id };
  },
  {
    schema: bodySchema,
    rateLimit: LIMITS.analyze,
    rateLimitKey: 'billing-checkout',
  },
);
