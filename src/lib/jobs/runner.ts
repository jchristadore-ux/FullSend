import 'server-only';
import { env } from '../env';
import { systemScope } from '../db';
import { db, enqueueOnce, getAnalysis, recordError } from '../db/repo';
import { isFullSendError } from '../errors';
import { nowIso } from '../ids';
import { logger } from '../logger';
import { systemAnalyzeProduct } from '../analysis/analyze';
import { buildStrategy, ensureBrandProfile } from '../strategy/build';
import { collectAnalytics } from '../analytics/collect';
import { optimize } from '../optimizer/optimize';
import { scheduleContent } from '../scheduler/schedule';
import { publishScheduledPost } from '../publish/publish';
import { checkAllConnections } from '../social/connections';
import { scanTrends } from '../trends/scan';
import { topUpContent } from '../automation/autopilot';
import { generateWeeklyReport } from '../automation/weekly-report';
import type { Job, JobType } from '../types';

const log = logger('jobs');
const LOCK_TIMEOUT_MS = 3 * 60 * 1000;
type Handler = (job: Job) => Promise<Record<string, unknown>>;

const handlers: Record<JobType, Handler> = {
  analyze_repository: async (job) => {
    const scope = systemScope('job:analyze_repository'); const projectId = String(job.payload.projectId); const project = await db().get(scope, 'projects', projectId); if (!project) throw new Error(`Project ${projectId} not found`);
    await db().update(scope, 'projects', projectId, { status: 'analyzing' });
    try {
      const result = await systemAnalyzeProduct(project, String(job.payload.repository), job.payload.githubToken ? String(job.payload.githubToken) : undefined, { refresh: Boolean(job.payload.refresh) });
      await db().update(scope, 'projects', projectId, { status: 'analyzed', updated_at: nowIso() });
      const key = `${projectId}:strategy:${Boolean(job.payload.refresh)}`;
      await enqueueOnce(scope, 'generate_strategy', { projectId, refresh: Boolean(job.payload.refresh), idempotencyKey: key }, { projectId, dedupeKey: key });
      return { analysisId: result.analysis.id, features: result.analysis.features.length, costUsd: result.costUsd, reused: !result.ran.analysis };
    } catch (e) { const kept = await getAnalysis(scope, projectId).catch(() => null); await db().update(scope, 'projects', projectId, { status: kept ? 'analyzed' : 'failed' }); throw e; }
  },
  generate_strategy: async (job) => {
    const scope = systemScope('job:generate_strategy'); const projectId = String(job.payload.projectId); const project = await db().get(scope, 'projects', projectId); if (!project) throw new Error(`Project ${projectId} not found`);
    const analysis = await db().findOne(scope, 'product_analysis', { where: { project_id: projectId }, orderBy: 'created_at', direction: 'desc' }); if (!analysis) throw new Error('No product analysis to build a strategy from');
    const personas = await db().find(scope, 'personas', { where: { project_id: projectId } }); const result = await buildStrategy(scope, project, analysis, personas, { refresh: Boolean(job.payload.refresh) });
    await db().update(scope, 'projects', projectId, { status: 'strategy_ready', updated_at: nowIso() });
    if (project.autopilot_mode === 'full_send' && !result.strategy.approved) await db().update(scope, 'marketing_strategies', result.strategy.id, { approved: true, approved_at: nowIso() });
    const key = `${projectId}:brand:${Boolean(job.payload.refresh)}`; await enqueueOnce(scope, 'generate_brand', { projectId, refresh: Boolean(job.payload.refresh), idempotencyKey: key }, { projectId, dedupeKey: key });
    return { strategyId: result.strategy.id, pillars: result.pillars.length, campaigns: result.campaigns.length, costUsd: result.costUsd, reused: result.costUsd === 0 };
  },
  generate_brand: async (job) => {
    const scope = systemScope('job:generate_brand'); const projectId = String(job.payload.projectId); const project = await db().get(scope, 'projects', projectId); if (!project) throw new Error(`Project ${projectId} not found`);
    const analysis = await getAnalysis(scope, projectId); if (!analysis) throw new Error('No product analysis to build a brand profile from'); const strategy = await db().findOne(scope, 'marketing_strategies', { where: { project_id: projectId }, orderBy: 'version', direction: 'desc' }); if (!strategy) throw new Error('No strategy to build a brand profile from');
    const { brand, costUsd } = await ensureBrandProfile(scope, project, analysis, strategy, { refresh: Boolean(job.payload.refresh) }); const key = `${projectId}:content:0`; await enqueueOnce(scope, 'generate_content', { projectId, days: 30, origin: 'initial', idempotencyKey: key }, { projectId, dedupeKey: key });
    return { brandId: brand.id, costUsd, reused: costUsd === 0 };
  },
  generate_content: async (job) => {
    const scope = systemScope('job:generate_content'); const projectId = String(job.payload.projectId); const project = await db().get(scope, 'projects', projectId); if (!project) throw new Error(`Project ${projectId} not found`);
    const days = Number(job.payload.days ?? 30); const result = await topUpContent(scope, project, days, job.payload.brief ? String(job.payload.brief) : undefined, (job.payload.origin as never) ?? 'initial');
    if (result.generated > 0) { await db().update(scope, 'projects', projectId, { status: 'content_ready', updated_at: nowIso() }); const key = `${projectId}:schedule`; await enqueueOnce(scope, 'schedule_content', { projectId, idempotencyKey: key }, { projectId, dedupeKey: key }); }
    return { ...result };
  },
  generate_creative: async (job) => { const scope = systemScope('job:generate_creative'); const item = await db().get(scope, 'content_items', String(job.payload.contentItemId)); if (!item) throw new Error('Content item not found'); return { contentId: item.id, assets: item.creative_asset_ids.length, note: 'Creative is materialized during content generation before scheduling.' }; },
  quality_control: async (job) => ({ projectId: String(job.payload.projectId), skipped: 'Quality control is executed as part of the content checkpoint.' }),
  schedule_content: async (job) => { const scope = systemScope('job:schedule_content'); const projectId = String(job.payload.projectId); const project = await db().get(scope, 'projects', projectId); if (!project) throw new Error(`Project ${projectId} not found`); const approved = await db().find(scope, 'content_items', { where: { project_id: projectId, status: 'approved' } }); const result = await scheduleContent(scope, project, approved); return { scheduled: result.scheduled.length, skipped: result.skipped.length }; },
  publish_post: async (job) => { const outcome = await publishScheduledPost(systemScope('job:publish_post'), String(job.payload.scheduledPostId)); return { status: outcome.status, error: outcome.error ?? null }; },
  collect_analytics: async (job) => ({ ...(await collectAnalytics(systemScope('job:collect_analytics'), String(job.payload.projectId))) }),
  optimize: async (job) => { const scope = systemScope('job:optimize'); const projectId = String(job.payload.projectId); const project = await db().get(scope, 'projects', projectId); if (!project) throw new Error(`Project ${projectId} not found`); const result = await optimize(scope, project); return { recommendations: result.recommendations.length, applied: result.applied.length, postsAnalyzed: result.postsAnalyzed }; },
  daily_autopilot: async (job) => {
    const scope = systemScope('job:daily_autopilot'); const projectId = String(job.payload.projectId); const project = await db().get(scope, 'projects', projectId); if (!project) throw new Error(`Project ${projectId} not found`);
    const queued: string[] = [];
    const stage = async (type: JobType, key: string, payload: Record<string, unknown> = {}) => { const { created } = await enqueueOnce(scope, type, { projectId, ...payload, idempotencyKey: key }, { projectId, dedupeKey: key }); if (created) queued.push(type); };
    await stage('refresh_tokens', `${projectId}:health`);
    await stage('generate_content', `${projectId}:autopilot-content`, { days: 14, origin: 'autopilot' });
    await stage('collect_analytics', `${projectId}:analytics`);
    await stage('optimize', `${projectId}:optimize`);
    await stage('scan_trends', `${projectId}:trends`);
    return { projectId, queued };
  },
  weekly_report: async (job) => { const report = await generateWeeklyReport(String(job.payload.projectId)); return { reportId: report.id, sendScore: report.send_score.total }; },
  refresh_tokens: async (job) => { const health = await checkAllConnections(String(job.payload.projectId)); return { healthy: health.healthy, needsAttention: health.needsAttention.length }; },
  scan_trends: async (job) => { const scope = systemScope('job:scan_trends'); const projectId = String(job.payload.projectId); const analysis = await db().findOne(scope, 'product_analysis', { where: { project_id: projectId }, orderBy: 'created_at', direction: 'desc' }); if (!analysis) return { signals: 0, skipped: 'no analysis' }; const result = await scanTrends(scope, projectId, analysis); return { signals: result.signals.length, participatable: result.participatable.length }; },
};

export function backoffSeconds(attempt: number): number { return Math.min(3600, 60 * 2 ** (attempt - 1)); }
export async function runJob(job: Job): Promise<{ status: 'succeeded' | 'failed' | 'dead' }> {
  const scope = systemScope('job runner'); const started = Date.now();
  try { const handler = handlers[job.type]; if (!handler) throw new Error(`No handler for job type ${job.type}`); const result = await handler(job); await db().update(scope, 'jobs', job.id, { status: 'succeeded', result, last_error: null, locked_at: null, updated_at: nowIso() }); log.info('job succeeded', { id: job.id, type: job.type, ms: Date.now() - started }); return { status: 'succeeded' }; }
  catch (e) { const message = e instanceof Error ? e.message : String(e); const retryable = isFullSendError(e) ? e.retryable : true; const exhausted = job.attempts >= job.max_attempts || !retryable; if (exhausted) { await db().update(scope, 'jobs', job.id, { status: 'dead', last_error: message, locked_at: null, updated_at: nowIso() }); await recordError(scope, { projectId: job.project_id, scope: `job:${job.type}`, message, remedy: isFullSendError(e) ? e.remedy : null, fatal: true }); return { status: 'dead' }; } const runAfter = new Date(Date.now() + backoffSeconds(job.attempts) * 1000).toISOString(); await db().update(scope, 'jobs', job.id, { status: 'queued', last_error: message, run_after: runAfter, locked_at: null, updated_at: nowIso() }); await recordError(scope, { projectId: job.project_id, scope: `job:${job.type}`, message, remedy: isFullSendError(e) ? e.remedy : null, fatal: false }); return { status: 'failed' }; }
}
export async function drainQueue(opts: { max?: number; budgetMs?: number; projectId?: string | null } = {}): Promise<{ processed: number; succeeded: number; failed: number; dead: number }> {
  const max = opts.max ?? 20; const budgetMs = opts.budgetMs ?? 50_000; const deadline = Date.now() + budgetMs; const ROOM_TO_RUN_MS = 25_000; let processed = 0, succeeded = 0, failed = 0, dead = 0;
  while (processed < max && Date.now() + ROOM_TO_RUN_MS < deadline) { const job = await db().claimNextJob(nowIso(), LOCK_TIMEOUT_MS, opts.projectId ?? null); if (!job) break; const { status } = await runJob(job); processed++; if (status === 'succeeded') succeeded++; else if (status === 'dead') dead++; else failed++; }
  return { processed, succeeded, failed, dead };
}
export async function queueStats(): Promise<{ queued: number; running: number; succeeded: number; failed: number; dead: number; oldestQueuedAt: string | null }> {
  const scope = systemScope('queue stats'); const jobs = await db().find(scope, 'jobs', { orderBy: 'created_at', direction: 'asc' }); const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, dead: 0 }; let oldestQueuedAt: string | null = null; for (const j of jobs) { if (j.status in counts) counts[j.status as keyof typeof counts]++; if (j.status === 'queued' && !oldestQueuedAt) oldestQueuedAt = j.run_after; } return { ...counts, oldestQueuedAt };
}
export function cronSecretValid(value: string | null): boolean { const secret = env.jobs.cronSecret; if (!secret || !value) return false; const trimmed = value.trim(); if (trimmed === secret) return true; const prefix = 'Bearer '; return trimmed.startsWith(prefix) && trimmed.slice(prefix.length).trim() === secret; }
