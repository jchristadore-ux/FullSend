/**
 * Stripe webhooks.
 *
 * Raw body + signature verify. Auth is the Stripe signature, not a session —
 * so this route does not use the shared `route()` helper.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { errorResponse } from '@/lib/api/handler';
import { FullSendError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { requireStripe } from '@/lib/billing/stripe';
import { handleStripeEvent } from '@/lib/billing/webhooks';

export const runtime = 'nodejs';

const log = logger('billing.webhook');

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    if (!env.stripe.enabled) {
      throw new FullSendError('billing_disabled', 'Billing is not configured', { status: 503 });
    }
    const secret = env.stripe.webhookSecret;
    if (!secret) {
      throw new FullSendError(
        'webhook_not_configured',
        'STRIPE_WEBHOOK_SECRET is not set',
        { status: 503, remedy: 'Add the webhook signing secret and redeploy.' },
      );
    }

    const signature = req.headers.get('stripe-signature');
    if (!signature) {
      throw new FullSendError('invalid_signature', 'Missing Stripe-Signature header', {
        status: 400,
      });
    }

    const rawBody = await req.text();
    const stripe = requireStripe();

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      log.warn('signature verification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new FullSendError('invalid_signature', 'Stripe signature verification failed', {
        status: 400,
      });
    }

    const result = await handleStripeEvent(event, (id) => stripe.subscriptions.retrieve(id));
    log.info('webhook handled', { type: event.type, result, id: event.id });
    return NextResponse.json({ received: true, result });
  } catch (e) {
    return errorResponse(e, req);
  }
}
