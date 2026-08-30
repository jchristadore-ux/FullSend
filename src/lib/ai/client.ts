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
import { jsonSchemaFor } from './json-schema';
import { DeterministicProvider } from './deterministic-provider';
import { AnthropicProvider } from './anthropic-provider';
import { OpenAiProvider } from './openai-provider';
import type { AiMessage, AiProvider, CompletionRequest, CompletionResponse, ModelTier } from './types';

const log = logger('ai');
let cached: AiProvider | null = null;

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
  'analysis.product': 'standard',
  'analysis.personas': 'standard',
  // Strategy is the longest structured response in the onboarding pipeline.
  // Keep it on the fast tier so one serverless invocation can finish it and
  // persist the checkpoint instead of being killed at the platform timeout.
  'strategy.build': 'fast',
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
export function tierFor(task: string): ModelTier { return TASK_TIERS[task] ?? 'fast'; }

export interface GenerateOptions<T> {
  task: string; system: string; brief: string; context: Record<string, unknown>;
  schema: z.ZodType<T>; jsonSchema?: Record<string, unknown>; tier?: ModelTier;
  maxTokens?: number; noCache?: boolean;
  attribution?: { scope: TenantScope; projectId?: Uuid | null; userId?: Uuid | null; campaignId?: Uuid | null; contentItemId?: Uuid | null };
}
export interface GenerateResult<T> { data: T; costUsd: number; model: string; cacheHit: boolean; }

export async function generateObject<T>(opts: GenerateOptions<T>): Promise<GenerateResult<T>> {
  const provider = getProvider();
  const tier = opts.tier ?? tierFor(opts.task);
  const model = provider.modelFor(tier);
  await assertWithinBudget(opts.attribution?.projectId ?? null);
  const jsonSchema = opts.jsonSchema ?? jsonSchemaFor(opts.schema) ?? undefined;
  const req: CompletionRequest = {
    task: opts.task, tier, system: opts.system,
    messages: [{ role: 'user', content: JSON.stringify({ brief: opts.brief, context: opts.context }, null, 2) }],
    maxTokens: opts.maxTokens,
    jsonSchema, noCache: opts.noCache,
  };
  const key = cacheKey(req, model);
  if (isCacheable(req)) {
    const hit = readCache(key);
    if (hit) {
      const parsed = tryParse(hit.text, opts.schema, jsonSchema);
      if (parsed.ok) { await ledger(opts, hit, tier); return { data: parsed.value, costUsd: 0, model: hit.model, cacheHit: true }; }
    }
  }

  // Keep structured onboarding generations comfortably below Vercel's 60s
  // function ceiling. The queue will retry the whole job if the provider fails.
  const startedAt = Date.now();
  const ROOM_FOR_A_SECOND_CALL_MS = 8_000;
  const maxTokens = opts.maxTokens ?? (opts.task === 'strategy.build' ? 2400 : 4000);
  const response = await provider.complete({ ...req, maxTokens });
  let parsed = tryParse(response.text, opts.schema, jsonSchema);
  let totalCost = response.costUsd;

  // A second AI call here is unsafe for a 60s serverless invocation. If the
  // first response is malformed late in the request, persist the failure and
  // let the durable queue retry it instead.
  if (!parsed.ok && Date.now() - startedAt >= ROOM_FOR_A_SECOND_CALL_MS) {
    throw new FullSendError('ai_invalid_output', `AI returned unusable output: ${parsed.error}`, {
      retryable: true, remedy: 'FullSend will retry this step automatically.',
      meta: { task: opts.task, model: response.model, retriedInline: false },
    });
  }
  if (!parsed.ok) {
    log.warn('AI response failed validation, retrying once', { task: opts.task, issue: parsed.error });
    const retry: CompletionRequest = { ...req, maxTokens, noCache: true, messages: correctionMessages(req.messages, response.text, parsed.error) };
    const repaired = await provider.complete(retry);
    totalCost += repaired.costUsd;
    parsed = tryParse(repaired.text, opts.schema, jsonSchema);
    if (!parsed.ok) throw new FullSendError('ai_invalid_output', `AI returned unusable output: ${parsed.error}`, {
      retryable: true, remedy: 'FullSend will retry this step automatically.', meta: { task: opts.task, model: repaired.model },
    });
    if (isCacheable(req)) writeCache(key, repaired);
    await ledger(opts, { ...repaired, costUsd: totalCost }, tier);
    return { data: parsed.value, costUsd: totalCost, model: repaired.model, cacheHit: false };
  }
  if (isCacheable(req)) writeCache(key, response);
  await ledger(opts, { ...response, costUsd: totalCost }, tier);
  return { data: parsed.value, costUsd: totalCost, model: response.model, cacheHit: false };
}

function correctionMessages(messages: AiMessage[], text: string, error: string): AiMessage[] {
  const instruction = `That response did not validate: ${error}\nReturn only the corrected JSON object. No prose, no code fences.`;
  const echo = text.slice(0, 4000).trim();
  if (echo) return [...messages, { role: 'assistant', content: echo }, { role: 'user', content: instruction }];
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return [...messages, { role: 'user', content: instruction }];
  return [...messages.slice(0, -1), { role: 'user', content: `${last.content}\n\nYour previous attempt returned nothing. ${instruction}` }];
}

function tryParse<T>(text: string, schema: z.ZodType<T>, jsonSchema?: Record<string, unknown>): { ok: true; value: T } | { ok: false; error: string } {
  const json = extractJson(text);
  if (json === null) return { ok: false, error: 'no JSON object found in the response' };
  let raw: unknown;
  try { raw = JSON.parse(json); } catch (e) { return { ok: false, error: `invalid JSON (${(e as Error).message})` }; }
  const result = schema.safeParse(coerceToSchema(raw, jsonSchema));
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
