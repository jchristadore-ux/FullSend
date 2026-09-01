import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env';
import { FullSendError } from '../errors';
import { isBillingFailure, providerMessage } from './provider-errors';
import { ANTHROPIC_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS } from './limits';
import { ANTHROPIC_MODELS, estimateCost } from './pricing';
import type { AiProvider, CompletionRequest, CompletionResponse, ModelTier } from './types';

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic'; readonly live: boolean; private client: Anthropic | null = null;
  constructor() { this.live = Boolean(env.ai.anthropicKey); }
  private sdk(): Anthropic {
    if (!this.client) {
      if (!env.ai.anthropicKey) throw new FullSendError('ai_not_configured', 'ANTHROPIC_API_KEY is not set', { remedy: 'Add ANTHROPIC_API_KEY to your environment, or set FULLSEND_AI_PROVIDER=openai.' });
      this.client = new Anthropic({ apiKey: env.ai.anthropicKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });
    }
    return this.client;
  }
  modelFor(tier: ModelTier): string { return ANTHROPIC_MODELS[tier]; }
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const model = this.modelFor(req.tier); const maxTokens = req.maxTokens ?? 4000;

    // Do not use Anthropic's output_config schema dialect here. The provider's
    // structured-output validator is intentionally narrower than JSON Schema
    // generated from Zod and has repeatedly rejected valid schemas containing
    // keywords such as minimum, maximum, maxItems and optional object fields.
    // FullSend already validates and repairs the response locally. Keeping the
    // schema out of output_config makes the vendor boundary stable while the
    // application retains strict Zod validation and durable job retries.
    const schemaInstruction = req.jsonSchema
      ? `\n\nReturn exactly one JSON value matching this shape. Do not add prose or markdown fences:\n${JSON.stringify(req.jsonSchema)}`
      : '';
    const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: `${req.system}${schemaInstruction}`, cache_control: { type: 'ephemeral' } }];
    const request: Anthropic.MessageCreateParams = {
      model,
      max_tokens: maxTokens,
      system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    let response: Anthropic.Message;
    try { response = await this.sdk().messages.create(request); } catch (e) { throw this.wrap(e, model); }
    if (response.stop_reason === 'refusal') throw new FullSendError('ai_refusal', 'The model declined this generation request', { remedy: 'Edit the campaign angle and retry.', meta: { task: req.task } });
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('').trim();
    const usage = { inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0), outputTokens: response.usage.output_tokens, cachedInputTokens: response.usage.cache_read_input_tokens ?? 0 };
    return { text, model, provider: this.name, usage, costUsd: estimateCost(model, usage), cacheHit: false };
  }
  private wrap(e: unknown, model: string): FullSendError {
    if (e instanceof Anthropic.RateLimitError) return new FullSendError('ai_rate_limited', 'AI provider rate limit reached', { status: 429, retryable: true, remedy: 'FullSend will retry this generation shortly.', meta: { model }, cause: e });
    if (e instanceof Anthropic.AuthenticationError) return new FullSendError('ai_auth_failed', 'The Anthropic API key was rejected', { status: 401, remedy: 'Check ANTHROPIC_API_KEY in your environment.', cause: e });
    if (e instanceof Anthropic.APIError) { const message = providerMessage(e); if (isBillingFailure(message)) return new FullSendError('ai_billing', 'Your Anthropic account is out of credit', { status: e.status, retryable: false, remedy: 'Add credit at console.anthropic.com → Plans & Billing.', meta: { model, status: e.status }, cause: e }); const retryable = (e.status ?? 500) >= 500; return new FullSendError('ai_error', `Anthropic API error: ${message}`, { retryable, remedy: retryable ? 'FullSend will retry.' : 'Anthropic rejected the request.', meta: { model, status: e.status }, cause: e }); }
    return new FullSendError('ai_error', `AI request failed: ${String(e)}`, { retryable: true, cause: e });
  }
}
