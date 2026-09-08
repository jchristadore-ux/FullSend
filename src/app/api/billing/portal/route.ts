import { route, LIMITS } from '@/lib/api/handler';
import { FullSendError } from '@/lib/errors';
import { env } from '@/lib/env';
import { billingEnabled } from '@/lib/billing/plans';
import { ensureStripeCustomer } from '@/lib/billing/customers';
import { requireStripe } from '@/lib/billing/stripe';
import { rethrowStripeBillingError } from '@/lib/billing/stripe-errors';

export const runtime = 'nodejs';

export const POST = route(
  async ({ session }) => {
    if (!billingEnabled()) {
      throw new FullSendError('billing_disabled', 'Billing is not configured on this deployment', {
        status: 503,
        remedy: 'The customer portal is unavailable until Stripe is configured.',
      });
    }

    try {
      const stripe = requireStripe();
      const { customerId } = await ensureStripeCustomer(session.scope, session.user);

      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${env.appUrl}/app/billing`,
      });

      return { url: portal.url };
    } catch (err) {
      rethrowStripeBillingError(err, 'portal');
    }
  },
  {
    rateLimit: LIMITS.billingCheckout,
    rateLimitKey: 'billing-portal',
  },
);
