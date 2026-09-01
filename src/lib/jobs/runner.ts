import 'server-only';
import { env } from '../env';
import { systemScope } from '../db';
import { db, enqueueOnce, getAnalysis, recordError } from '../db/repo';
import { FullSendError, isFullSendError } from '../errors';
import { nowIso } from '../ids';
import { queueStamp } from './clock';
import { reportJobFailure } from '../ops/report-failure';
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
/**
 * A ceiling on how far one Generate can chain. Six posts a batch, so a
 * calendar tops out around sixty — comfortably more than any window the
 * product offers, and a hard stop if a slot ever fails to fill.
 */
const MAX_CONTENT_BATCHES = 10;
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
    const { brand, costUsd } = await ensureBrandProfile(scope, project, analysis, strategy, { refresh: Boolean(job.payload.refresh) }); const key = `${projectId}:content:30:0`; await enqueueOnce(scope, 'generate_content', { projectId, days: 30, origin: 'initial', batch: 0, idempotencyKey: key }, { projectId, dedupeKey: key });
    return { brandId: brand.id, costUsd, reused: costUsd === 0 };
  },
  /*
   * One batch of posts per job — never "write me thirty".
   *
   * Each batch persists the posts it wrote before this job returns, so a
   * calendar half-built is a calendar half-saved. While slots remain, the job
   * queues the next batch and stops; the worker picks that up on a later pass.
   * A batch that writes nothing new ends the chain rather than looping.
   */
  generate_content: async (job) => {
    const scope = systemScope('job:generate_content'); const projectId = String(job.payload.projectId); const project = await db().get(scope, 'projects', projectId); if (!project) throw new Error(`Project ${projectId} not found`);
    const days = Number(job.payload.days ?? 30); const batchIndex = Number(job.payload.batch ?? 0);
    const result = await topUpContent(scope, project, days, job.payload.brief ? String(job.payload.brief) : undefined, (job.payload.origin as never) ?? 'initial');
    let nextBatchQueued = false;
    if (result.generated > 0) {
      await db().update(scope, 'projects', projectId, { status: 'content_ready', updated_at: nowIso() });
      const key = `${projectId}:schedule`; await enqueueOnce(scope, 'schedule_content', { projectId, idempotencyKey: key }, { projectId, dedupeKey: key });
      if (result.remainingSlots > 0 && batchIndex + 1 < MAX_CONTENT_BATCHES) {
        const next = batchIndex + 1; const nextKey = `${projectId}:content:${days}:${next}`;
        const { created } = await enqueueOnce(scope, 'generate_content', { projectId, days, origin: job.payload.origin ?? 'initial', brief: job.payload.brief ?? null, batch: next, idempotencyKey: nextKey }, { projectId, dedupeKey: nextKey });
        nextBatchQueued = created;
      }
    }
    return { ...result, batch: batchIndex, nextBatchQueued };
  },
  generate_creative: async (job) => { const scope = systemScope('job:generate_creative'); const item = await db().get(scope, 'content_items', String(job.payload.contentItemId)); if (!item) throw new Error('Content item not found'); return { contentId: item.id, assets: item.creative_asset_ids.length, note: 'Creative is materialized during content generation before scheduling.' }; },
  quality_control: async (job) => ({ projectId: String(job.payload.projectId), skipped: 'Quality control is executed as part of the content checkpoint.' }),
  schedule_content: async (job) => { const scope = systemScope('job:schedule_content'); const projectId = String(job.payload.projectId); const project = await db().get(scope, 'projects', projectId); if (!project) throw new Error(`Project ${projectId} not found`); const approved = await db().find(scope, 'content_items', { where: { project_id: projectId, status: 'approved' } }); const result = await scheduleContent(scope, project, approved); return { scheduled: result.scheduled.length, skipped: result.skipped.length }; },
  /*
   * One post, one job. A post that is only retrying must not leave a
   * *succeeded* job behind — that is how a post ends up waiting for a retry
   * nothing will ever perform. Throwing hands the retry to the queue, which
   * already knows how to back off and when to give up, and keeps the publish
   * schedule in one place rather than two that can disagree.
   */
  publish_post: async (job) => {
    const outcome = await publishScheduledPost(systemScope('job:publish_post'), String(job.payload.scheduledPostId));
    if (outcome.status === 'retrying') {
      throw new FullSendError('publish_retrying', outcome.error ?? 'The publish did not complete', { retryable: true, remedy: outcome.remedy ?? null, meta: { retryAfter: outcome.nextAttemptAt ?? null } });
    }
    return { status: outcome.status, error: outcome.error ?? null, remedy: outcome.remedy ?? null };
  },
  // One bounded pass of insights calls. Anything it did not reach is queued
  // for the next pass rather than kept inside this one.
  collect_analytics: async (job) => {
    const scope = systemScope('job:collect_analytics'); const projectId = String(job.payload.projectId);
    const result = await collectAnalytics(scope, projectId);
    // Only while it is still getting somewhere. A pass that reads nothing has
    // no reason to believe the next one would, and chaining on it would spend
    // every worker pass on a queue that never shortens.
    if (result.remaining > 0 && result.postsCollected > 0) { const key = `${projectId}:analytics:${result.remaining}`; await enqueueOnce(scope, 'collect_analytics', { projectId, idempotencyKey: key }, { projectId, dedupeKey: key }); }
    return { ...result };
  },
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
  catch (e) { const message = e instanceof Error ? e.message : String(e); const retryable = isFullSendError(e) ? e.retryable : true; const exhausted = job.attempts >= job.max_attempts || !retryable; if (exhausted) { const remedy = isFullSendError(e) ? e.remedy : null; await db().update(scope, 'jobs', job.id, { status: 'dead', last_error: message, locked_at: null, updated_at: nowIso() }); await recordError(scope, { projectId: job.project_id, scope: `job:${job.type}`, message, remedy, fatal: true });
      // A job that has given up is the one failure nobody finds on their own.
      // Reporting is best-effort and never throws — the durable record above
      // is already written, so a lost issue loses nothing.
      await reportJobFailure({ job, message, remedy });
      return { status: 'dead' }; } // A failure that already knows when it may be tried again — a publish holding
    // its own backoff, a platform naming a retry-after — decides its own slot;
    // the queue's exponential backoff is the floor, never an override.
    const ownBackoff = isFullSendError(e) ? String(e.meta?.retryAfter ?? '') : ''; const defaultRunAfter = Date.now() + backoffSeconds(job.attempts) * 1000; const parsedOwn = ownBackoff ? Date.parse(ownBackoff) : NaN; const runAfter = new Date(Number.isNaN(parsedOwn) ? defaultRunAfter : Math.max(parsedOwn, Date.now() + 1000)).toISOString(); await db().update(scope, 'jobs', job.id, { status: 'queued', last_error: message, run_after: runAfter, locked_at: null, updated_at: nowIso() }); await recordError(scope, { projectId: job.project_id, scope: `job:${job.type}`, message, remedy: isFullSendError(e) ? e.remedy : null, fatal: false }); return { status: 'failed' }; }
}

/**
 * Jobs that call an AI provider or a publishing API — the ones whose duration
 * belongs to somebody else's servers. A pass runs at most one of these, so no
 * invocation can ever become "30 AI generations" or "30 publications".
 */
export const HEAVY_JOBS: ReadonlySet<JobType> = new Set<JobType>([
  'analyze_repository',
  'generate_strategy',
  'generate_brand',
  'generate_content',
  'generate_creative',
  'optimize',
  'collect_analytics',
  'scan_trends',
  'weekly_report',
  'publish_post',
]);

/** Budget a pass keeps in reserve before starting another job. */
export const JOB_HEADROOM_MS = 5_000;

export interface DrainResult {
  processed: number;
  succeeded: number;
  failed: number;
  dead: number;
  /** Why the pass ended. Recorded, not guessed, so a caller can act on it. */
  stopped: 'empty' | 'max' | 'budget' | 'heavy';
}

/**
 * One bounded worker pass. Three independent bounds, each closing a different
 * way an invocation used to become a long-running request:
 *
 *   • At most one *heavy* job — anything that calls an AI provider or publishes
 *     to Instagram. A backlog of thirty generations takes thirty passes, never
 *     one long one.
 *
 *   • At most `max` jobs, and never past the elapsed-time budget. Light
 *     bookkeeping jobs drain quickly; the pass still ends well inside the
 *     invocation it was given.
 *
 *   • Only jobs that already existed when the pass began. A completed job
 *     enqueues its successor and that successor belongs to the *next* pass,
 *     which is what stops one invocation walking
 *     analyse → strategy → brand → content as a single chain of AI calls.
 *
 * So the queue genuinely drains, while no single invocation can grow without
 * limit. Every one of those bounds is covered by a test.
 */
export async function drainQueue(
  opts: { max?: number; budgetMs?: number; projectId?: string | null; maxHeavy?: number } = {},
): Promise<DrainResult> {
  const max = Math.max(1, Math.min(opts.max ?? 1, 50));
  const maxHeavy = Math.max(1, opts.maxHeavy ?? 1);
  // Taken as given: a pass with less budget than the reserve starts nothing,
  // which is the correct answer for an invocation that is already nearly over.
  const budgetMs = opts.budgetMs ?? 50_000;
  const startedAt = queueStamp();
  const deadline = Date.now() + budgetMs;

  let processed = 0,
    succeeded = 0,
    failed = 0,
    dead = 0,
    heavy = 0;
  let stopped: DrainResult['stopped'] = 'max';

  while (processed < max) {
    if (Date.now() + JOB_HEADROOM_MS > deadline) {
      stopped = 'budget';
      break;
    }
    const job = await db().claimNextJob(nowIso(), LOCK_TIMEOUT_MS, {
      projectId: opts.projectId ?? null,
      createdBefore: startedAt,
    });
    if (!job) {
      stopped = 'empty';
      break;
    }

    const { status } = await runJob(job);
    processed++;
    if (status === 'succeeded') succeeded++;
    else if (status === 'dead') dead++;
    else failed++;

    if (HEAVY_JOBS.has(job.type)) {
      heavy++;
      if (heavy >= maxHeavy) {
        stopped = 'heavy';
        break;
      }
    }
  }
  return { processed, succeeded, failed, dead, stopped };
}

export async function queueStats(): Promise<{ queued: number; running: number; succeeded: number; failed: number; dead: number; oldestQueuedAt: string | null }> {
  const scope = systemScope('queue stats'); const jobs = await db().find(scope, 'jobs', { orderBy: 'created_at', direction: 'asc' }); const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, dead: 0 }; let oldestQueuedAt: string | null = null; for (const j of jobs) { if (j.status in counts) counts[j.status as keyof typeof counts]++; if (j.status === 'queued' && !oldestQueuedAt) oldestQueuedAt = j.run_after; } return { ...counts, oldestQueuedAt };
}
export function cronSecretValid(value: string | null): boolean { const secret = env.jobs.cronSecret; if (!secret || !value) return false; const trimmed = value.trim(); if (trimmed === secret) return true; const prefix = 'Bearer '; return trimmed.startsWith(prefix) && trimmed.slice(prefix.length).trim() === secret; }