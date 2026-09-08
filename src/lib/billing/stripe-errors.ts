/**
 * Map Stripe SDK failures to FullSendError with founder-facing remedies.
 * Used by checkout and portal so mode/price/customer mistakes are not opaque 500s.
 */
import { FullSendError, isFullSendError } from '../errors';

function stripeMessage(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as { message?: string };
  return typeof e.message === 'string' ? e.message : String(err);
}

function stripeCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { code?: string };
  return typeof e.code === 'string' ? e.code : undefined;
}

/**
 * Rethrow as FullSendError when we recognize a common Stripe billing failure.
 * Unknown errors become a retryable stripe_error (502) instead of an unhandled 500.
 */
export function rethrowStripeBillingError(
  err: unknown,
  context: 'checkout' | 'portal',
): never {
  if (isFullSendError(err)) throw err;

  const message = stripeMessage(err);
  const code = stripeCode(err);
  const lower = message.toLowerCase();

  if (
    /similar object exists in (test|live) mode/i.test(message) ||
    (/test mode/i.test(lower) && /live mode/i.test(lower))
  ) {
    throw new FullSendError(
      'stripe_mode_mismatch',
      'Stripe object does not match the configured API key mode (test vs live)',
      {
        status: 503,
        remedy:
          'Stripe secret key and price/customer IDs must all be test or all live. Update env vars and redeploy.',
        cause: err,
        meta: { stripeMessage: message },
      },
    );
  }

  if (/no such customer/i.test(message) || (code === 'resource_missing' && /customer/i.test(message))) {
    throw new FullSendError(
      'stripe_customer_missing',
      'Stripe customer is missing or belongs to a different Stripe mode',
      {
        status: 409,
        retryable: true,
        remedy:
          context === 'checkout'
            ? 'Try checkout again — FullSend will create a fresh Stripe customer if the old one was from test mode.'
            : 'Try opening the portal again. If it keeps failing after a test→live key switch, contact support from the Control Room.',
        cause: err,
        meta: { stripeMessage: message },
      },
    );
  }

  if (/no such price/i.test(message) || (code === 'resource_missing' && /price/i.test(message))) {
    throw new FullSendError(
      'stripe_price_missing',
      'Stripe price ID is missing or belongs to a different Stripe mode',
      {
        status: 503,
        remedy:
          'Check STRIPE_PRICE_SEND / STRIPE_PRICE_FULL_SEND / STRIPE_PRICE_AGENCY match the current Stripe mode (test vs live) and redeploy.',
        cause: err,
        meta: { stripeMessage: message },
      },
    );
  }

  throw new FullSendError('stripe_error', `Stripe ${context} request failed`, {
    status: 502,
    retryable: true,
    remedy:
      'Try again in a moment. If it keeps failing, check the Stripe Dashboard logs and the FullSend Control Room.',
    cause: err,
    meta: { stripeMessage: message, stripeCode: code ?? null },
  });
}
