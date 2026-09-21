/**
 * Per-tenant rate limiting on AI provider calls.
 *
 * The shared Anthropic/OpenAI key is one pool. Without a per-tenant ceiling, a
 * single account on full_send autopilot can burn the whole monthly budget (and
 * trip the provider's own rate limit) before anyone else generates a post.
 *
 * This is a call-rate guard, not a dollar budget — `assertWithinBudget` still
 * caps spend. Together they keep one tenant from exhausting either the key's
 * throughput or the deployment's dollars.
 */
import 'server-only';
import { check, LIMITS, type LimitRule } from '../rate-limit';
import { FullSendError } from '../errors';
import type { Uuid } from '../types';

/** Default: 40 generation attempts per tenant per hour. Overridable via env. */
export function tenantAiRule(): LimitRule {
  const raw = Number(process.env.FULLSEND_AI_TENANT_HOURLY_LIMIT ?? '40');
  const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 40;
  return { limit, windowMs: LIMITS.aiTenant.windowMs };
}

/**
 * Key a tenant for the AI limiter.
 *
 * Prefer userId (the billing/account boundary). Fall back to projectId when a
 * background job has no user on the attribution. System/mock calls with
 * neither are not limited — they are the install's own work.
 */
export function tenantAiKey(opts: {
  userId?: Uuid | null;
  projectId?: Uuid | null;
}): string | null {
  if (opts.userId) return `ai:user:${opts.userId}`;
  if (opts.projectId) return `ai:project:${opts.projectId}`;
  return null;
}

/**
 * Enforce the per-tenant AI call ceiling. Throws `rate_limited` when exceeded.
 */
export function assertTenantAiAllowance(opts: {
  userId?: Uuid | null;
  projectId?: Uuid | null;
}): void {
  const key = tenantAiKey(opts);
  if (!key) return;
  const rule = tenantAiRule();
  try {
    check(key, rule);
  } catch (e) {
    if (e instanceof FullSendError && e.code === 'rate_limited') {
      throw new FullSendError(
        'ai_tenant_rate_limited',
        'This account has hit its hourly AI generation limit',
        {
          status: 429,
          retryable: true,
          remedy:
            'Wait for the hourly window to reset, or raise FULLSEND_AI_TENANT_HOURLY_LIMIT if this install should allow more. Other accounts are unaffected.',
          meta: {
            ...(e.meta ?? {}),
            tenantKey: key.startsWith('ai:user:') ? 'user' : 'project',
            limit: rule.limit,
          },
        },
      );
    }
    throw e;
  }
}
