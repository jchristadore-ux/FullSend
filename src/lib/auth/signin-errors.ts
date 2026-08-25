/**
 * Supabase Auth reports magic-link failures as prose. Almost none of them are
 * the user's fault, and almost none are fixed by re-typing the address — they
 * are project settings the founder has to change in the Supabase dashboard.
 *
 * This maps the message to the setting that actually needs changing, so the
 * sign-in screen names the fix instead of blaming the address.
 */

/** The next step for a Supabase sign-in failure, or null when none fits. */
export function signInRemedy(message: string): string | null {
  const m = message.toLowerCase();

  // We gave up on Supabase before the host gave up on us. Almost always the
  // built-in mailer, which has no delivery guarantee and no hurry.
  if (m.includes('timeout') || m.includes('aborted') || m.includes('timed out')) {
    return 'Supabase did not respond in time — usually its built-in email sender stalling. Add your own under Authentication → Emails → SMTP Settings, and check Logs → Auth Logs.';
  }

  // The request never reached Supabase at all.
  if (m.includes('fetch failed') || m.includes('network') || m.includes('enotfound')) {
    return 'Could not reach Supabase. Check that NEXT_PUBLIC_SUPABASE_URL is your real project URL and that the project is not paused.';
  }

  // Signups are off, so an unknown address cannot be created on first sign-in.
  if (m.includes('signups not allowed') || m.includes('signup is disabled')) {
    return 'Supabase → Authentication → Sign In / Providers → Email → turn on "Allow new users to sign up". Or invite this address under Authentication → Users first.';
  }

  // The email provider itself is switched off.
  if (m.includes('email logins are disabled') || m.includes('email provider')) {
    return 'Supabase → Authentication → Sign In / Providers → enable the Email provider.';
  }

  // Supabase accepted the request but could not deliver the mail. The built-in
  // sender is for testing only and gives up quickly.
  if (m.includes('error sending') || m.includes('smtp')) {
    return 'Supabase could not send the email. Its built-in sender only handles a couple of messages an hour — add your own under Authentication → Emails → SMTP Settings. Supabase → Logs → Auth Logs shows the delivery error.';
  }

  if (m.includes('rate limit') || m.includes('too many requests')) {
    return 'Supabase is rate-limiting sign-in emails — its built-in sender allows only a few per hour. Wait, or configure SMTP under Authentication → Emails.';
  }

  if (m.includes('redirect') || m.includes('not allowed for this instance')) {
    return 'Add your callback to Supabase → Authentication → URL Configuration → Redirect URLs, and set Site URL to your deployed domain.';
  }

  // Only now is the address itself a plausible cause.
  if (m.includes('invalid') && m.includes('email')) {
    return 'Check the address and try again.';
  }

  return 'Supabase → Logs → Auth Logs shows the underlying failure.';
}
