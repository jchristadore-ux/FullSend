import 'server-only';
import OpenAI from 'openai';
import { env } from '../env';
import { FullSendError } from '../errors';
import { isBillingFailure, providerMessage } from './provider-errors';
import { estimateCost, OPENAI_MODELS } from './pricing';
import type { AiProvider, CompletionRequest, CompletionResponse, ModelTier } from './types';

/** OpenAI adapter. Same contract as the Anthropic one; routing picks between them. */
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  readonly live: boolean;
  private client: OpenAI | null = null;

  constructor() {
    this.live = Boolean(env.ai.openaiKey);
  }

  private sdk(): OpenAI {
    if (!this.client) {
      if (!env.ai.openaiKey) {
        throw new FullSendError('ai_not_configured', 'OPENAI_API_KEY is not set', {
          remedy: 'Add OPENAI_API_KEY, or set FULLSEND_AI_PROVIDER=anthropic.',
        });
      }
      // Same reasoning as the Anthropic adapter: fail visibly rather than sit
      // on one step for half an hour.
      this.client = new OpenAI({
        apiKey: env.ai.openaiKey,
        maxRetries: 2,
        timeout: 120_000,
      });
    }
    return this.client;
  }

  modelFor(tier: ModelTier): string {
    return OPENAI_MODELS[tier];
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const model = this.modelFor(req.tier);
    try {
      const res = await this.sdk().chat.completions.create({
        model,
        max_completion_tokens: req.maxTokens ?? 8000,
        ...(req.jsonSchema ? { response_format: { type: 'json_object' as const } } : {}),
        messages: [
          {
            role: 'system' as const,
            content: req.jsonSchema
              ? `${req.system}\n\nRespond with a single JSON object matching this schema:\n${JSON.stringify(req.jsonSchema)}`
              : req.system,
          },
          ...req.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      });

      const text = res.choices[0]?.message?.content?.trim() ?? '';
      const usage = {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        cachedInputTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      };
      return {
        text,
        model,
        provider: this.name,
        usage,
        costUsd: estimateCost(model, usage),
        cacheHit: false,
      };
    } catch (e) {
      if (e instanceof OpenAI.RateLimitError) {
        throw new FullSendError('ai_rate_limited', 'AI provider rate limit reached', {
          status: 429,
          retryable: true,
          remedy: 'FullSend will retry this generation shortly.',
          cause: e,
        });
      }
      if (e instanceof OpenAI.APIError) {
        const message = providerMessage(e);

        // Same as Anthropic: a spent balance is a billing problem, not a
        // temporary one, and retrying it forever helps nobody.
        if (isBillingFailure(message)) {
          throw new FullSendError('ai_billing', 'Your OpenAI account is out of credit', {
            status: e.status,
            retryable: false,
            remedy:
              'Add credit at platform.openai.com → Billing. Everything FullSend has already made is kept, and generation resumes once there is a balance.',
            meta: { model, status: e.status },
            cause: e,
          });
        }

        const retryable = (e.status ?? 500) >= 500;
        throw new FullSendError('ai_error', `OpenAI API error: ${message}`, {
          retryable,
          remedy: retryable
            ? 'FullSend will retry. If it persists, check the OpenAI status page.'
            : 'OpenAI rejected the request rather than failing temporarily, so retrying will not help. The message above is theirs.',
          meta: { model, status: e.status },
          cause: e,
        });
      }
      throw new FullSendError('ai_error', `AI request failed: ${String(e)}`, {
        retryable: true,
        cause: e,
      });
    }
  }
}
