import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env';
import { FullSendError } from '../errors';
import { isBillingFailure, providerMessage } from './provider-errors';
import { ANTHROPIC_MODELS, estimateCost } from './pricing';
import type { AiProvider, CompletionRequest, CompletionResponse, ModelTier } from './types';

/**
 * Anthropic adapter.
 *
 * The system prompt carries a cache breakpoint: FullSend generates many posts
 * against one unchanging brand + product context, so that prefix is written to
 * cache once and read back at a tenth of the price for every post after it.
 */
/**
 * Shorter than the invocation that holds it.
 *
 * Two minutes was longer than the sixty seconds a serverless function gets, so
 * the function was always killed before the request could time out. The job
 * row was left claimed with no error on it — "cut off part-way and never
 * reported back", with nothing after the colon, because there was nothing to
 * report. A request that fails inside the job writes down why.
 */
const REQUEST_TIMEOUT_MS = 40_000;

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly live: boolean;
  private client: Anthropic | null = null;

  constructor() {
    this.live = Boolean(env.ai.anthropicKey);
  }

  private sdk(): Anthropic {
    if (!this.client) {
      if (!env.ai.anthropicKey) {
        throw new FullSendError('ai_not_configured', 'ANTHROPIC_API_KEY is not set', {
          remedy: 'Add ANTHROPIC_API_KEY to your environment, or set FULLSEND_AI_PROVIDER=openai.',
        });
      }
      /*
       * The SDK default is a ten-minute request timeout with three retries,
       * which is half an hour of a progress screen sitting on one step before
       * anything is reported. No generation here legitimately takes two
       * minutes, so a request that has is not coming back: fail it, and let
       * the job queue retry it with backoff where the founder can see it.
       */
      this.client = new Anthropic({
        apiKey: env.ai.anthropicKey,
        maxRetries: 1,
        timeout: REQUEST_TIMEOUT_MS,
      });
    }
    return this.client;
  }

  modelFor(tier: ModelTier): string {
    return ANTHROPIC_MODELS[tier];
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const model = this.modelFor(req.tier);
    /*
     * Eight thousand tokens is close to a minute of writing on its own, which
     * is the whole invocation. Nothing FullSend asks for needs that much: the
     * largest schema here is the strategy, and it fits in well under half.
     */
    const maxTokens = req.maxTokens ?? 4000;

    // JSON is requested via the system prompt rather than a tool, so the
    // response stays a single text block and the cache prefix stays stable.
    const system: Anthropic.TextBlockParam[] = [
      {
        type: 'text',
        text: req.system,
        cache_control: { type: 'ephemeral' },
      },
    ];
    if (req.jsonSchema) {
      system.push({
        type: 'text',
        text:
          'Respond with a single JSON object and nothing else — no prose, no markdown ' +
          'fences. It must match this JSON Schema:\n' +
          JSON.stringify(req.jsonSchema),
      });
    }

    let response: Anthropic.Message;
    try {
      response = await this.sdk().messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      });
    } catch (e) {
      throw this.wrap(e, model);
    }

    if (response.stop_reason === 'refusal') {
      throw new FullSendError('ai_refusal', 'The model declined this generation request', {
        remedy:
          'This usually means the brief touched a restricted topic. Edit the campaign angle and retry.',
        meta: { task: req.task },
      });
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const usage = {
      inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
      cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
    };

    return {
      text,
      model,
      provider: this.name,
      usage,
      costUsd: estimateCost(model, usage),
      cacheHit: false,
    };
  }

  private wrap(e: unknown, model: string): FullSendError {
    if (e instanceof Anthropic.RateLimitError) {
      return new FullSendError('ai_rate_limited', 'AI provider rate limit reached', {
        status: 429,
        retryable: true,
        remedy: 'FullSend will retry this generation shortly.',
        meta: { model },
        cause: e,
      });
    }
    if (e instanceof Anthropic.AuthenticationError) {
      return new FullSendError('ai_auth_failed', 'The Anthropic API key was rejected', {
        status: 401,
        remedy: 'Check ANTHROPIC_API_KEY in your environment.',
        cause: e,
      });
    }
    if (e instanceof Anthropic.APIError) {
      const message = providerMessage(e);

      // An empty balance is not a temporary fault, and no amount of retrying
      // adds credit. It arrives as a 400 like any other rejected request, so
      // without this it would be reported as something to wait out.
      if (isBillingFailure(message)) {
        return new FullSendError('ai_billing', 'Your Anthropic account is out of credit', {
          status: e.status,
          retryable: false,
          remedy:
            'Add credit at console.anthropic.com → Plans & Billing. Everything FullSend has already made is kept, and generation resumes once there is a balance.',
          meta: { model, status: e.status },
          cause: e,
        });
      }

      const retryable = (e.status ?? 500) >= 500;
      return new FullSendError('ai_error', `Anthropic API error: ${message}`, {
        retryable,
        remedy: retryable
          ? 'FullSend will retry. If it persists, check the Anthropic status page.'
          : 'Anthropic rejected the request rather than failing temporarily, so retrying will not help. The message above is theirs.',
        meta: { model, status: e.status },
        cause: e,
      });
    }
    return new FullSendError('ai_error', `AI request failed: ${String(e)}`, {
      retryable: true,
      cause: e,
    });
  }
}
