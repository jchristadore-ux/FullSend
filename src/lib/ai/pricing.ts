/**
 * Model catalogue and cost maths.
 *
 * Prices are USD per million tokens. Cached input reads bill at ~10% of the
 * input rate, cache writes at ~125%; both are modelled so the ledger reflects
 * what caching actually saves.
 */

import type { ModelTier } from './types';

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok: number;
  cacheWritePerMTok: number;
  contextTokens: number;
}

export const ANTHROPIC_MODELS: Record<ModelTier, string> = {
  fast: 'claude-haiku-4-5',
  standard: 'claude-sonnet-5',
  premium: 'claude-opus-5',
};

/**
 * OpenAI model ids move faster than this file can. They are overridable so a
 * deployment can point at whatever is current without a code change.
 */
export const OPENAI_MODELS: Record<ModelTier, string> = {
  fast: process.env.OPENAI_MODEL_FAST ?? 'gpt-4.1-mini',
  standard: process.env.OPENAI_MODEL_STANDARD ?? 'gpt-4.1',
  premium: process.env.OPENAI_MODEL_PREMIUM ?? 'gpt-4.1',
};

const PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cachedInputPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    contextTokens: 200_000,
  },
  'claude-sonnet-5': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cachedInputPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
    contextTokens: 1_000_000,
  },
  'claude-opus-5': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cachedInputPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    contextTokens: 1_000_000,
  },
  'gpt-4.1-mini': {
    inputPerMTok: 0.4,
    outputPerMTok: 1.6,
    cachedInputPerMTok: 0.1,
    cacheWritePerMTok: 0.4,
    contextTokens: 1_000_000,
  },
  'gpt-4.1': {
    inputPerMTok: 2,
    outputPerMTok: 8,
    cachedInputPerMTok: 0.5,
    cacheWritePerMTok: 2,
    contextTokens: 1_000_000,
  },
};

/** Unknown models fall back to a conservative estimate rather than $0. */
const FALLBACK: ModelPricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cachedInputPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
  contextTokens: 200_000,
};

export function pricingFor(model: string): ModelPricing {
  return PRICING[model] ?? FALLBACK;
}

export function estimateCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): number {
  const p = pricingFor(model);
  const freshInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cost =
    (freshInput / 1_000_000) * p.inputPerMTok +
    (usage.cachedInputTokens / 1_000_000) * p.cachedInputPerMTok +
    (usage.outputTokens / 1_000_000) * p.outputPerMTok;
  // Sub-cent precision matters when a post costs a fraction of a cent.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Rough token estimate for budgeting before a call is made. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}
