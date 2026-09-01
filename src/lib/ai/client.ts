import 'server-only';
import type { z } from 'zod';
import { env } from '../env';
import { FullSendError } from '../errors';
import { logger } from '../logger';
import { db, recordAiUsage } from '../db/repo';
import { systemScope, type TenantScope } from '../db';
import type { Uuid } from '../types';
import { cacheKey, isCacheable, readCache, writeCache } from './cache';
import { coerceToSchema } from './coerce';
import { anthropicJsonSchemaFor, jsonSchemaFor } from './json-schema';
import { DeterministicProvider } from './deterministic-provider';
import { AnthropicProvider } from './anthropic-provider';
import { OpenAiProvider } from './openai-provider';
import type { AiMessage, AiProvider, CompletionRequest, CompletionResponse, ModelTier } from './types';

const log = logger('ai');
let cached: AiProvider | null = null;
const GENERATION_BUDGET_MS = 50_000;
const REPAIR_RESERVE_MS = 10_000;

/**
 * Tasks that may be composed when the model's own answer is unusable.
 *
 * The line is what a stage reads. Everything here transforms an artefact that
 * has already been checked against the repository — the product analysis —
 * so composing one rearranges facts that are already true.
 *
 * `analysis.product` is deliberately absent, and that absence is the point.
 * It is the only stage whose input is the repository itself, so a composed
 * analysis would be a guess presented as a reading of somebody's code, and
 * every later stage's honesty rests on it: the content rules forbid claiming a
 * capability that is not in the verified feature list, and this is where that
 * list comes from. If a model cannot read the repository, FullSend says so
 * rather than inventing a product.
 */
const COMPOSABLE_TASKS: ReadonlySet<string> = new Set([
  'analysis.personas',
  'strategy.build',
  'brand.profile',
  'content.batch',
  'optimizer.recommendations',
  'report.weekly',
  'trends.scan',
]);

export function getProvider(): AiProvider {
  if (cached) return cached;
  switch (env.ai.provider) {
    case 'anthropic': cached = new AnthropicProvider(); break;
    case 'openai': cached = new OpenAiProvider(); break;
    default: cached = new DeterministicProvider();
  }
  return cached;
}
export function setProvider(p: AiProvider | null): void { cached = p; }

const TASK_TIERS: Record<string, ModelTier> = {
  'analysis.product': 'standard', 'analysis.personas': 'standard', 'strategy.build': 'fast', 'brand.profile': 'fast',
  'content.batch': 'standard', 'content.single': 'fast', 'content.rewrite': 'fast', 'qc.judgement': 'fast',
  'optimizer.recommendations': 'premium', 'report.weekly': 'standard', 'trends.scan': 'fast', 'video.plan': 'standard',
};
export function tierFor(task: string): ModelTier { return TASK_TIERS[task] ?? 'fast'; }

export interface GenerateOptions<T> {
  task: string; system: string; brief: string; context: Record<string, unknown>;
  schema: z.ZodType<T>; jsonSchema?: Record<string, unknown>; tier?: ModelTier;
  maxTokens?: number; noCache?: boolean;
  attribution?: { scope: TenantScope; projectId?: Uuid | null; userId?: Uuid | null; campaignId?: Uuid | null; contentItemId?: Uuid | null };
}
export interface GenerateResult<T> { data: T; costUsd: number; model: string; cacheHit: boolean; }

export async function generateObject<T>(opts: GenerateOptions<T>): Promise<GenerateResult<T>> {
  const startedAt = Date.now();
  const provider = getProvider();
  const tier = opts.tier ?? tierFor(opts.task);
  const model = provider.modelFor(tier);
  await assertWithinBudget(opts.attribution?.projectId ?? null);

  // Keep the complete schema for local repair/validation. Provider dialects are
  // derived separately so vendor restrictions can never weaken validation.
  // Local validation/repair MUST always use the canonical schema derived from
  // the Zod validator. opts.jsonSchema is an optional provider override and may
  // intentionally use a vendor dialect that omits constraints or properties.
  // Using that override for coercion caused valid repair logic to be skipped
  // (not_capabilities objects, overlong category strings, etc.).
  const validationSchema = jsonSchemaFor(opts.schema) ?? undefined;
  const derivedProviderSchema = provider.name === 'anthropic' ? anthropicJsonSchemaFor(opts.schema) : validationSchema;
  const providerSchema = opts.jsonSchema ?? derivedProviderSchema ?? undefined;
  const req: CompletionRequest = {
    task: opts.task, tier, system: opts.system,
    messages: [{ role: 'user', content: JSON.stringify({ brief: opts.brief, context: opts.context }, null, 2) }],
    maxTokens: opts.maxTokens, jsonSchema: providerSchema, noCache: opts.noCache,
  };
  const key = cacheKey(req, model);
  if (isCacheable(req)) {
    const hit = readCache(key);
    if (hit) {
      const parsed = tryParse(hit.text, opts.schema, validationSchema);
      if (parsed.ok) { await ledger(opts, hit, tier); return { data: parsed.value, costUsd: 0, model: hit.model, cacheHit: true }; }
    }
  }

  const maxTokens = opts.maxTokens ?? (opts.task === 'strategy.build' ? 2400 : 4000);
  const response = await provider.complete({ ...req, maxTokens });
  let parsed = tryParse(response.text, opts.schema, validationSchema);
  let totalCost = response.costUsd;

  if (!parsed.ok) {
    const elapsed = Date.now() - startedAt;
    const budgetForRepair = elapsed + REPAIR_RESERVE_MS < GENERATION_BUDGET_MS;

    if (budgetForRepair) {
      log.warn('AI response failed validation, attempting one repair', { task: opts.task, issue: parsed.error, responseChars: response.text.length });
      const retry: CompletionRequest = {
        ...req, maxTokens, noCache: true,
        messages: correctionMessages(req.messages, response.text, parsed.error),
      };
      const repaired = await provider.complete(retry);
      totalCost += repaired.costUsd;
      parsed = tryParse(repaired.text, opts.schema, validationSchema);
      if (parsed.ok) {
        if (isCacheable(req)) writeCache(key, repaired);
        await ledger(opts, { ...repaired, costUsd: totalCost }, tier);
        return { data: parsed.value, costUsd: totalCost, model: repaired.model, cacheHit: false };
      }
    }

    /*
     * Compose it rather than lose the run.
     *
     * A model that omits a required field is not an outage and not a bug in
     * this code — it is a coin flip. The same strategy request succeeded that
     * morning and failed that afternoon on `value_proposition` and
     * `posting_cadence`, and a founder five days into a launch lost the whole
     * pipeline to it. Every stage carries this risk, because every stage
     * validates a model's JSON against a schema it can decline to honour.
     *
     * The deterministic composer already exists for exactly this, and says so
     * in its own header: a provider failure should degrade the machine, not
     * stop it. It was only ever reachable when no API key was configured,
     * which is the one case where it is least needed. Wiring it in here makes
     * it the floor under every task it covers — analysis, strategy, brand,
     * content, optimizer, weekly report, trends — all of them.
     *
     * Nothing is faked by doing this. The composer builds from the verified
     * product analysis rather than inventing claims, the usage ledger records
     * the provider as `deterministic`, and the UI reads the provider from
     * there — so a composed plan is visibly a composed plan.
     *
     * It is a floor, not a hiding place: the result is validated like any
     * other, and if it does not hold up the original error is still thrown.
     */
    const composed = await composeFallback(opts, req, maxTokens, validationSchema);
    if (composed) {
      log.warn('AI output was unusable; composed this stage deterministically instead', {
        task: opts.task, model, issue: parsed.error,
      });
      totalCost += composed.response.costUsd;
      await ledger(opts, { ...composed.response, costUsd: totalCost }, tier);
      // Deliberately not cached: the cache key belongs to the live model's
      // request, and a composed answer must not be served as that model's.
      return { data: composed.value as T, costUsd: totalCost, model: composed.response.model, cacheHit: false };
    }

    throw new FullSendError('ai_invalid_output', `AI returned unusable output: ${parsed.error}`, {
      retryable: true, remedy: 'FullSend will retry this step automatically.', meta: { task: opts.task, model },
    });
  }
  if (isCacheable(req)) writeCache(key, response);
  await ledger(opts, { ...response, costUsd: totalCost }, tier);
  return { data: parsed.value, costUsd: totalCost, model: response.model, cacheHit: false };
}

/**
 * The composer's answer to the same request, if it can produce a valid one.
 *
 * Returns null rather than throwing: this is the last thing tried before
 * giving up, and a failure here must leave the model's own error as the one
 * reported, not replace it with a confusing second one.
 */
async function composeFallback<T>(
  opts: GenerateOptions<T>,
  req: CompletionRequest,
  maxTokens: number,
  validationSchema: Record<string, unknown> | undefined,
): Promise<{ value: T; response: CompletionResponse } | null> {
  if (!COMPOSABLE_TASKS.has(opts.task)) return null;
  try {
    const composer = new DeterministicProvider();
    const response = await composer.complete({ ...req, maxTokens, noCache: true, jsonSchema: undefined });
    const parsed = tryParse(response.text, opts.schema, validationSchema);
    return parsed.ok ? { value: parsed.value, response } : null;
  } catch (e) {
    log.warn('deterministic fallback could not compose this task', { task: opts.task, error: String(e) });
    return null;
  }
}

function correctionMessages(messages: AiMessage[], text: string, error: string): AiMessage[] {
  const instruction = `That response did not validate: ${error}\nReturn only the corrected JSON object. No prose, no code fences.`;
  const echo = text.slice(0, 4000).trim();
  if (echo) return [...messages, { role: 'assistant', content: echo }, { role: 'user', content: instruction }];
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return [...messages, { role: 'user', content: instruction }];
  return [...messages.slice(0, -1), { role: 'user', content: `${last.content}\n\nYour previous attempt returned nothing. ${instruction}` }];
}

function tryParse<T>(text: string, schema: z.ZodType<T>, validationSchema?: Record<string, unknown>): { ok: true; value: T } | { ok: false; error: string } {
  const json = extractJson(text);
  if (json === null) return { ok: false, error: 'no JSON object found in the response' };
  let raw: unknown;
  try { raw = JSON.parse(json); } catch (e) { return { ok: false, error: `invalid JSON (${(e as Error).message})` }; }
  const result = schema.safeParse(coerceToSchema(raw, validationSchema));
  if (!result.success) return { ok: false, error: result.error.issues.slice(0, 8).map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  return { ok: true, value: result.data };
}

export function extractJson(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : trimmed;
  if (body.startsWith('{') || body.startsWith('[')) return body;
  const start = body.search(/[{[]/); if (start === -1) return null;
  const open = body[start], close = open === '{' ? '}' : ']'; let depth = 0, inString = false, escaped = false;
  for (let i = start; i < body.length; i++) { const ch = body[i]; if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; } if (ch === '"') inString = true; else if (ch === open) depth++; else if (ch === close) { depth--; if (depth === 0) return body.slice(start, i + 1); } }
  return null;
}

async function ledger<T>(opts: GenerateOptions<T>, response: CompletionResponse, tier: ModelTier): Promise<void> {
  const a = opts.attribution; if (!a) return;
  try { await recordAiUsage(a.scope, { project_id: a.projectId ?? null, user_id: a.userId ?? null, campaign_id: a.campaignId ?? null, content_item_id: a.contentItemId ?? null, provider: response.provider, model: response.model, task: `${opts.task}:${tier}`, input_tokens: response.usage.inputTokens, output_tokens: response.usage.outputTokens, cached_input_tokens: response.usage.cachedInputTokens, cost_usd: response.costUsd, cache_hit: response.cacheHit }); }
  catch (e) { log.warn('failed to record AI usage', { error: String(e) }); }
}

async function assertWithinBudget(projectId: Uuid | null): Promise<void> {
  const budget = env.ai.monthlyBudgetUsd; if (!Number.isFinite(budget) || budget <= 0) return;
  const since = new Date(); since.setUTCDate(1); since.setUTCHours(0,0,0,0);
  try { const rows = await db().find(systemScope('budget check'), 'ai_usage', { gte: { created_at: since.toISOString() } }); const spent = rows.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0); if (spent >= budget) throw new FullSendError('ai_budget_exceeded', `Monthly AI budget of $${budget} reached`, { status: 402, remedy: 'Raise FULLSEND_AI_MONTHLY_BUDGET_USD, or wait for the next billing month. Publishing of already-generated content continues normally.', meta: { spent, budget, projectId } }); }
  catch (e) { if (e instanceof FullSendError && e.code === 'ai_budget_exceeded') throw e; }
}

export async function aiSpend(scope: TenantScope, opts: { projectId?: Uuid; since?: string } = {}): Promise<{ total: number; byTask: Record<string, number>; calls: number; cacheHits: number }> {
  const rows = await db().find(scope, 'ai_usage', { where: opts.projectId ? { project_id: opts.projectId } : undefined, gte: opts.since ? { created_at: opts.since } : undefined });
  const byTask: Record<string, number> = {}; let total = 0, cacheHits = 0;
  for (const r of rows) { const cost = Number(r.cost_usd ?? 0); total += cost; byTask[r.task] = (byTask[r.task] ?? 0) + cost; if (r.cache_hit) cacheHits++; }
  return { total: Math.round(total * 1e6) / 1e6, byTask, calls: rows.length, cacheHits };
}
