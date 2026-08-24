/**
 * Response cache.
 *
 * Analysis and strategy calls are deterministic enough to reuse: the same repo
 * at the same commit produces the same understanding. Caching those is the
 * single biggest cost saving in the product, so re-running onboarding or
 * regenerating a strategy costs nothing the second time.
 */

import { sha256 } from '../ids';
import type { CompletionRequest, CompletionResponse } from './types';

interface Entry {
  value: CompletionResponse;
  expiresAt: number;
}

const store = new Map<string, Entry>();
const MAX_ENTRIES = 500;

/** Tasks whose output is safe to reuse. Content generation is never cached. */
const CACHEABLE_TASKS = new Set([
  'analysis.product',
  'analysis.personas',
  'strategy.build',
  'brand.profile',
]);

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Bump when generation logic changes in a way that should invalidate cached
 * output. The prompt is part of the key already, so this only matters for
 * changes the prompt does not capture — chiefly the deterministic composer,
 * whose output is a function of code rather than of the prompt.
 */
const CACHE_VERSION = process.env.FULLSEND_CACHE_VERSION ?? '2';

export function cacheKey(req: CompletionRequest, model: string): string {
  return sha256(
    JSON.stringify({
      v: CACHE_VERSION,
      task: req.task,
      model,
      system: req.system,
      messages: req.messages,
      schema: req.jsonSchema ?? null,
    }),
  );
}

export function isCacheable(req: CompletionRequest): boolean {
  return !req.noCache && CACHEABLE_TASKS.has(req.task);
}

export function readCache(key: string, now = Date.now()): CompletionResponse | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    store.delete(key);
    return null;
  }
  // A cache hit costs nothing — reflect that in the ledger.
  return { ...hit.value, cacheHit: true, costUsd: 0 };
}

export function writeCache(key: string, value: CompletionResponse, now = Date.now()): void {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
  store.set(key, { value, expiresAt: now + TTL_MS });
}

export function clearCache(): void {
  store.clear();
}

export function cacheStats(): { entries: number } {
  return { entries: store.size };
}
