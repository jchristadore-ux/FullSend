/**
 * The AI client every engine calls.
 *
 * Responsibilities: pick a provider, route to the cheapest tier that can do the
 * job, serve from cache when the task allows it, enforce the monthly budget,
 * parse and validate JSON, and record every cent in the ledger.
 */
import 'server-only';
import type { z } from 'zod';
import { env } from '../env';
import { FullSendError } from '../errors';
import { logger } from '../logger';
import { db, recordAiUsage } from '../db/repo';
import { systemScope, type TenantScope } from '../db';
import type { Uuid } from '../types';
import { cacheKey, isCacheable, readCache, writeCache } from './cache';
import { DeterministicProvider } from './deterministic-provider';
import type { AiProvider, CompletionRequest, CompletionResponse, ModelTier } from './types';

const log = logger('ai');

let cached: AiProvider | null = null;

export function getProvider(): AiProvider {
  if (cached) return cached;
  switch (env.ai.provider) {
    case 'anthropic': {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AnthropicProvider } =
        require('./anthropic-provider') as typeof import('./anthropic-provider');
      cached = new AnthropicProvider();
      break;
    }
    case 'openai': {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { OpenAiProvider } = require('./openai-provider') as typeof import('./openai-provider');
      cached = new OpenAiProvider();
      break;
    }
    default:
      cached = new DeterministicProvider();
  }
  return cached;
}

/** Test seam. */
export function setProvider(p: AiProvider | null): void {
  cached = p;
}

/**
 * Which tier a task needs. Everything that is essentially formatting or
 * templating runs on the cheap model; only judgement-heavy work goes premium.
 */
const TASK_TIERS: Record<string, ModelTier> = {
  'analysis.product': 'standard',
  'analysis.personas': 'standard',
  'strategy.build': 'premium',
  'brand.profile': 'fast',
  'content.batch': 'standard',
  'content.single': 'fast',
  'content.rewrite': 'fast',
  'qc.judgement': 'fast',
  'optimizer.recommendations': 'premium',
  'report.weekly': 'standard',
  'trends.scan': 'fast',
  'video.plan': 'standard',
};

export function tierFor(task: string): ModelTier {
  return TASK_TIERS[task] ?? 'fast';
}

export interface GenerateOptions<T> {
  task: string;
  system: string;
  brief: string;
  /** Structured input. Also what the deterministic provider composes from. */
  context: Record<string, unknown>;
  schema: z.ZodType<T>;
  jsonSchema?: Record<string, unknown>;
  tier?: ModelTier;
  maxTokens?: number;
  noCache?: boolean;
  /** Attribution for the cost ledger. */
  attribution?: {
    scope: TenantScope;
    projectId?: Uuid | null;
    userId?: Uuid | null;
    campaignId?: Uuid | null;
    contentItemId?: Uuid | null;
  };
}

export interface GenerateResult<T> {
  data: T;
  costUsd: number;
  model: string;
  cacheHit: boolean;
}

/**
 * Generates a validated object. Retries once with the validation errors fed
 * back, which is far cheaper than failing a whole content batch.
 */
export async function generateObject<T>(opts: GenerateOptions<T>): Promise<GenerateResult<T>> {
  const provider = getProvider();
  const tier = opts.tier ?? tierFor(opts.task);
  const model = provider.modelFor(tier);

  await assertWithinBudget(opts.attribution?.projectId ?? null);

  const req: CompletionRequest = {
    task: opts.task,
    tier,
    system: opts.system,
    messages: [
      {
        role: 'user',
        content: JSON.stringify({ brief: opts.brief, context: opts.context }, null, 2),
      },
    ],
    maxTokens: opts.maxTokens,
    jsonSchema: opts.jsonSchema,
    noCache: opts.noCache,
  };

  const key = cacheKey(req, model);
  if (isCacheable(req)) {
    const hit = readCache(key);
    if (hit) {
      const parsed = tryParse(hit.text, opts.schema);
      if (parsed.ok) {
        await ledger(opts, hit, tier);
        return { data: parsed.value, costUsd: 0, model: hit.model, cacheHit: true };
      }
    }
  }

  let response = await provider.complete(req);
  let parsed = tryParse(response.text, opts.schema);
  let totalCost = response.costUsd;

  if (!parsed.ok) {
    log.warn('AI response failed validation, retrying once', {
      task: opts.task,
      issue: parsed.error,
    });
    const retry: CompletionRequest = {
      ...req,
      noCache: true,
      messages: [
        ...req.messages,
        { role: 'assistant', content: response.text.slice(0, 4000) },
        {
          role: 'user',
          content:
            `That response did not validate: ${parsed.error}\n` +
            'Return only the corrected JSON object. No prose, no code fences.',
        },
      ],
    };
    response = await provider.complete(retry);
    totalCost += response.costUsd;
    parsed = tryParse(response.text, opts.schema);
    if (!parsed.ok) {
      throw new FullSendError('ai_invalid_output', `AI returned unusable output: ${parsed.error}`, {
        retryable: true,
        remedy: 'FullSend will retry this step automatically.',
        meta: { task: opts.task, model: response.model },
      });
    }
  }

  if (isCacheable(req)) writeCache(key, response);
  await ledger(opts, { ...response, costUsd: totalCost }, tier);

  return { data: parsed.value, costUsd: totalCost, model: response.model, cacheHit: false };
}

function tryParse<T>(
  text: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
  const json = extractJson(text);
  if (json === null) return { ok: false, error: 'no JSON object found in the response' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `invalid JSON (${(e as Error).message})` };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: issues };
  }
  return { ok: true, value: result.data };
}

/** Tolerates code fences and stray prose around the object. */
export function extractJson(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : trimmed;
  if (body.startsWith('{') || body.startsWith('[')) return body;
  const start = body.search(/[{[]/);
  if (start === -1) return null;
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

async function ledger<T>(
  opts: GenerateOptions<T>,
  response: CompletionResponse,
  tier: ModelTier,
): Promise<void> {
  const attribution = opts.attribution;
  if (!attribution) return;
  try {
    await recordAiUsage(attribution.scope, {
      project_id: attribution.projectId ?? null,
      user_id: attribution.userId ?? null,
      campaign_id: attribution.campaignId ?? null,
      content_item_id: attribution.contentItemId ?? null,
      provider: response.provider,
      model: response.model,
      task: `${opts.task}:${tier}`,
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
      cached_input_tokens: response.usage.cachedInputTokens,
      cost_usd: response.costUsd,
      cache_hit: response.cacheHit,
    });
  } catch (e) {
    // Never let bookkeeping break a generation.
    log.warn('failed to record AI usage', { error: String(e) });
  }
}

/** Hard stop before the monthly budget is blown, rather than after. */
async function assertWithinBudget(projectId: Uuid | null): Promise<void> {
  const budget = env.ai.monthlyBudgetUsd;
  if (!Number.isFinite(budget) || budget <= 0) return;
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  try {
    const rows = await db().find(systemScope('budget check'), 'ai_usage', {
      gte: { created_at: since.toISOString() },
    });
    const spent = rows.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
    if (spent >= budget) {
      throw new FullSendError('ai_budget_exceeded', `Monthly AI budget of $${budget} reached`, {
        status: 402,
        remedy:
          'Raise FULLSEND_AI_MONTHLY_BUDGET_USD, or wait for the next billing month. ' +
          'Publishing of already-generated content continues normally.',
        meta: { spent, budget, projectId },
      });
    }
  } catch (e) {
    if (e instanceof FullSendError && e.code === 'ai_budget_exceeded') throw e;
    // A failed budget read must not block generation.
  }
}

/** Total AI spend, used by the Control Room and the per-project cost panel. */
export async function aiSpend(
  scope: TenantScope,
  opts: { projectId?: Uuid; since?: string } = {},
): Promise<{ total: number; byTask: Record<string, number>; calls: number; cacheHits: number }> {
  const rows = await db().find(scope, 'ai_usage', {
    where: opts.projectId ? { project_id: opts.projectId } : undefined,
    gte: opts.since ? { created_at: opts.since } : undefined,
  });
  const byTask: Record<string, number> = {};
  let total = 0;
  let cacheHits = 0;
  for (const r of rows) {
    const cost = Number(r.cost_usd ?? 0);
    total += cost;
    byTask[r.task] = (byTask[r.task] ?? 0) + cost;
    if (r.cache_hit) cacheHits++;
  }
  return { total: Math.round(total * 1e6) / 1e6, byTask, calls: rows.length, cacheHits };
}
