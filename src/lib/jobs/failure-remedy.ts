/**
 * The next step for a failed background job.
 *
 * A job records only its last error as text, so whatever reads it back has to
 * derive the remedy. Onboarding used to show one fixed line — "check the
 * repository is public" — under every failure, including an out-of-credit AI
 * account, which sent people to look at the wrong thing entirely.
 *
 * Deliberately importable from the browser: no `server-only`, no imports.
 */
export function failureRemedy(message: string): string {
  const m = message.toLowerCase();

  if (/credit balance|out of credit|insufficient_quota|billing|exceeded your current quota/.test(m))
    return 'Your AI account is out of credit. Add some at console.anthropic.com → Plans & Billing (or platform.openai.com → Billing), then run this again. Nothing already made is lost.';

  if (/api key|unauthorized|401|authentication/.test(m))
    return 'The AI API key was rejected. Check ANTHROPIC_API_KEY in your hosting environment, then redeploy.';

  if (/monthly ai budget|budget reached/.test(m))
    return 'FullSend hit its own monthly AI spending cap. Raise FULLSEND_AI_MONTHLY_BUDGET_USD, or wait for next month.';

  if (/rate limit|429|too many requests/.test(m))
    return 'The AI provider is rate-limiting. FullSend retries automatically — give it a few minutes.';

  if (/not found|404|could not find the repository/.test(m))
    return 'That repository could not be read. Check the URL, and that it is public — private repositories need a GITHUB_TOKEN.';

  if (/github rate limit|api rate limit exceeded/.test(m))
    return "GitHub's anonymous rate limit is 60 requests an hour. Set GITHUB_TOKEN to raise it.";

  if (/table.*does not exist|schema cache|relation .* does not exist/.test(m))
    return 'The database tables are missing. Run supabase/migrations/0001_fullsend_init.sql in the Supabase SQL Editor.';

  return 'The Control Room at /admin shows this failure with its full context, alongside the job queue and API usage.';
}
