import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env';
import { FullSendError } from '../errors';
import { ANTHROPIC_MODELS, estimateCost } from './pricing';
import type { AiProvider, CompletionRequest, CompletionResponse, ModelTier } from './types';

/**
 * Anthropic adapter.
 *
 * The system prompt carries a cache breakpoint: FullSend generates many posts
 * against one unchanging brand + product context, so that prefix is written to
 * cache once and read back at a tenth of the price for every post after it.
 */
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
      this.client = new Anthropic({ apiKey: env.ai.anthropicKey, maxRetries: 3 });
    }
    return this.client;
  }

  modelFor(tier: ModelTier): string {
    return ANTHROPIC_MODELS[tier];
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const model = this.modelFor(req.tier);
    const maxTokens = req.maxTokens ?? 8000;

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
      return new FullSendError('ai_error', `Anthropic API error: ${e.message}`, {
        retryable: (e.status ?? 500) >= 500,
        remedy: 'FullSend will retry. If it persists, check the Anthropic status page.',
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
