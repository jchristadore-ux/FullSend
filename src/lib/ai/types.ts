/**
 * Provider-agnostic AI interface.
 *
 * FullSend never talks to a vendor SDK directly — everything goes through
 * `AiProvider`, so a model or vendor swap is a one-line routing change and the
 * cost ledger stays accurate.
 */

/**
 * Routing tiers. Simple, high-volume work goes to `fast`; only genuinely hard
 * reasoning reaches `premium`. This is the main lever on cost per customer.
 */
export type ModelTier = 'fast' | 'standard' | 'premium';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  /** Names the call site, e.g. `content.caption`. Drives routing and the ledger. */
  task: string;
  tier: ModelTier;
  /**
   * Stable prefix (brand profile, product analysis). Marked for prompt caching
   * so the same context across a batch of posts is billed once.
   */
  system: string;
  messages: AiMessage[];
  maxTokens?: number;
  /** When set, the provider is asked to return JSON matching this shape. */
  jsonSchema?: Record<string, unknown>;
  /** Skip the response cache for calls that must vary (e.g. new content). */
  noCache?: boolean;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface CompletionResponse {
  text: string;
  model: string;
  provider: string;
  usage: AiUsage;
  costUsd: number;
  /** True when served from FullSend's own response cache (zero marginal cost). */
  cacheHit: boolean;
}

export interface AiProvider {
  readonly name: string;
  /** Reports whether real credentials are present. Never guessed. */
  readonly live: boolean;
  modelFor(tier: ModelTier): string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}
