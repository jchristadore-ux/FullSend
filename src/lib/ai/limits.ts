/**
 * The numbers that bound a single AI request.
 *
 * They live together because they are not independent. A generation asks for
 * some number of output tokens; the provider client gives up after some number
 * of seconds; if the first exceeds what the second can produce, the request
 * dies every time and no amount of retrying helps. That is a whole class of
 * production failure, and it is invisible when the two numbers sit in
 * different files — which is exactly how it happened here: the content batch
 * asked for 9000 output tokens against a 40-second ceiling, and every run
 * either timed out or came back truncated mid-JSON.
 *
 * So they are one module, and a test holds them against each other.
 */
import 'server-only';

/** How long the Anthropic client waits before abandoning a request. */
export const ANTHROPIC_REQUEST_TIMEOUT_MS = 40_000;

/** How long the OpenAI client waits before abandoning a request. */
export const OPENAI_REQUEST_TIMEOUT_MS = 25_000;

/**
 * The tightest ceiling any configured provider imposes.
 *
 * A generation is sized against this rather than against whichever provider
 * happens to be configured today, because the provider is one environment
 * variable and the batch size is a deploy.
 */
export const MIN_PROVIDER_TIMEOUT_MS = Math.min(
  ANTHROPIC_REQUEST_TIMEOUT_MS,
  OPENAI_REQUEST_TIMEOUT_MS,
);

/**
 * A deliberately pessimistic sustained output rate, in tokens per second.
 *
 * Not a benchmark and not a promise — a floor to size against. Models under
 * load run slower than models on a quiet afternoon, and a generation must
 * survive the bad afternoon. The production failure is consistent with it:
 * roughly 7000 tokens did not land inside 40 seconds, which puts the observed
 * rate well under 180/s, and this assumes far less than that.
 */
export const SLOW_OUTPUT_TOKENS_PER_SEC = 60;

/** How long `outputTokens` should be assumed to take, on a bad afternoon. */
export function estimatedGenerationMs(outputTokens: number): number {
  return (outputTokens / SLOW_OUTPUT_TOKENS_PER_SEC) * 1000;
}
