/**
 * Turning a vendor API failure into something a founder can act on.
 *
 * Both SDKs put the whole JSON envelope into `error.message`, so the raw text
 * reads as a wall of braces with the one useful sentence buried inside it. And
 * the failures that matter most here are not transient — an empty balance is
 * not something retrying fixes, and telling someone to check a status page
 * when their account simply needs credit sends them to the wrong place.
 */

/** The provider's own sentence, not the JSON envelope it arrived in. */
export function providerMessage(error: { message: string; error?: unknown }): string {
  const body = error.error as { error?: { message?: unknown }; message?: unknown } | undefined;
  const inner = body?.error?.message ?? body?.message;
  if (typeof inner === 'string' && inner.trim()) return inner.trim();

  // Fall back to the envelope, minus the leading status code the SDKs prepend.
  return error.message.replace(/^\d{3}\s+/, '').trim();
}

/** Out of credit, over a quota, or otherwise refused for payment. */
export function isBillingFailure(message: string): boolean {
  return /credit balance|insufficient_quota|insufficient funds|billing|exceeded your current quota/i.test(
    message,
  );
}
