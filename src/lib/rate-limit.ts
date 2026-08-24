/**
 * Fixed-window rate limiting.
 *
 * In-process by default, which is correct for a single Vercel instance and for
 * tests. Where multiple instances matter the same interface is satisfied by a
 * Postgres-backed counter; the limiter is called through `check()` either way.
 */

import { rateLimited } from './errors';

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

export interface LimitRule {
  /** Requests permitted per window. */
  limit: number;
  windowMs: number;
}

export const LIMITS = {
  /** Repo analysis is the most expensive thing a user can trigger. */
  analyze: { limit: 5, windowMs: 60 * 60 * 1000 },
  generateContent: { limit: 20, windowMs: 60 * 60 * 1000 },
  oauthStart: { limit: 10, windowMs: 10 * 60 * 1000 },
  publishManual: { limit: 30, windowMs: 60 * 60 * 1000 },
  api: { limit: 300, windowMs: 60 * 1000 },
  authAttempt: { limit: 10, windowMs: 15 * 60 * 1000 },
} as const satisfies Record<string, LimitRule>;

export function check(key: string, rule: LimitRule, now = Date.now()): void {
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + rule.windowMs });
    return;
  }
  if (w.count >= rule.limit) {
    throw rateLimited(Math.ceil((w.resetAt - now) / 1000));
  }
  w.count += 1;
}

export function remaining(key: string, rule: LimitRule, now = Date.now()): number {
  const w = windows.get(key);
  if (!w || w.resetAt <= now) return rule.limit;
  return Math.max(0, rule.limit - w.count);
}

export function resetLimits(): void {
  windows.clear();
}

/** Periodic sweep so long-lived instances don't accumulate dead windows. */
export function sweep(now = Date.now()): void {
  for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
}
