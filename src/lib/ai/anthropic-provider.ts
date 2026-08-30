import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env';
import { FullSendError } from '../errors';
import { isBillingFailure, providerMessage } from './provider-errors';
import { ANTHROPIC_MODELS, estimateCost } from './pricing';
import type { AiProvider, CompletionRequest, CompletionResponse, ModelTier } from './types';

const REQUEST_TIMEOUT_MS = 40_000;

type StructuredAnthropicRequest = Anthropic.MessageCreateParams & {
  output_config?: { format: { type: 'json_schema'; schema: Record<string, unknown> } };
  thinking?: { type: 'disabled' };
};

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
      this.client = new Anthropic({ apiKey: env.ai.anthropicKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });
    }
    return this.client;
  }

  modelFor(tier: ModelTier): string {
    return ANTHROPIC_MODELS[tier];
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const model = this.modelFor(req.tier);
    const maxTokens = req.maxTokens ?? 4000;
    const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];

    const request: StructuredAnthropicRequest = {
      model,
      max_tokens: maxTokens,
      system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    // Machine-readable stages use Anthropic's native structured-output contract.
    // Prompting for JSON alone is not reliable enough for a durable pipeline.
    if (req.jsonSchema) {
      request.output_config = {
        format: {
          type: 'json_schema',
          schema: req.jsonSchema,
        },
      };
      // Keep the output budget for the actual JSON rather than hidden reasoning.
      request.thinking = { type: 'disabled' };
    }

    let response: Anthropic.Message;
    try {
      response = await this.sdk().messages.create(request);
    } catch (e) { throw this.wrap(e, model); }
    if (response.stop_reason === 'refusal') throw new FullSendError('ai_refusal', 'The model declined this generation request', { remedy: 'Edit the campaign angle and retry.', meta: { task: req.task } });
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('').trim();
    const usage = { inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0), outputTokens: response.usage.output_tokens, cachedInputTokens: response.usage.cache_read_input_tokens ?? 0 };
    return { text, model, provider: this.name, usage, costUsd: estimateCost(model, usage), cacheHit: false };
  }

  private wrap(e: unknown, model: string): FullSendError {
    if (e instanceof Anthropic.RateLimitError) return new FullSendError('ai_rate_limited', 'AI provider rate limit reached', { status: 429, retryable: true, remedy: 'FullSend will retry this generation shortly.', meta: { model }, cause: e });
    if (e instanceof Anthropic.AuthenticationError) return new FullSendError('ai_auth_failed', 'The Anthropic API key was rejected', { status: 401, remedy: 'Check ANTHROPIC_API_KEY in your environment.', cause: e });
    if (e instanceof Anthropic.APIError) {
      const message = providerMessage(e);
      if (isBillingFailure(message)) return new FullSendError('ai_billing', 'Your Anthropic account is out of credit', { status: e.status, retryable: false, remedy: 'Add credit at console.anthropic.com → Plans & Billing.', meta: { model, status: e.status }, cause: e });
      const retryable = (e.status ?? 500) >= 500;
      return new FullSendError('ai_error', `Anthropic API error: ${message}`, { retryable, remedy: retryable ? 'FullSend will retry.' : 'Anthropic rejected the request.', meta: { model, status: e.status }, cause: e });
    }
    return new FullSendError('ai_error', `AI request failed: ${String(e)}`, { retryable: true, cause: e });
  }
}
