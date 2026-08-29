/**
 * Background job runner.
 *
 * The founder's browser is never part of the loop. Work is enqueued as a row,
 * claimed atomically by a worker, retried with backoff on failure, and marked
 * dead (never silently dropped) when it exhausts its attempts.
 *
 * In production this is driven by Vercel Cron hitting /api/cron/*; the same
 * runner also works as a long-lived worker process via scripts/worker.ts.
 */
import 'server-only';
import { env } from '../env';
import { systemScope } from '../db';
import { db, enqueue, enqueueOnce, getAnalysis, recordError } from '../db/repo';
import { isFullSendError } from '../errors';
import { nowIso } from '../ids';
import { logger } from '../logger';
import { systemAnalyzeProduct } from '../analysis/analyze';
import { buildStrategy } from '../strategy/build';
import { collectAnalytics } from '../analytics/collect';
import { optimize } from '../optimizer/optimize';
import { scheduleContent } from '../scheduler/schedule';
import { publishScheduledPost } from '../publish/publish';
import { checkAllConnections } from '../social/connections';
import { scanTrends } from '../trends/scan';
import { runDailyAutopilot, topUpContent } from '../automation/autopilot';
import { generateWeeklyReport } from '../automation/weekly-report';
import type { Job, JobType } from '../types';

const log = logger('jobs');

/**
 * A running job older than this is assumed to have died with its worker.
 *
 * Ten minutes was the old value, and it was the length of the stall: the
 * workers here are serverless invocations that are killed at sixty seconds, so
 * a job that outgrew its invocation left a `running` row that nothing would
 * reclaim for ten minutes — no error, no progress, nothing for the founder to
 * do but watch. Three minutes is comfortably longer than any invocation can
 * live and short enough that a death is recovered from while someone is still
 * looking at the screen.
 */
const LOCK_TIMEOUT_MS = 3 * 60 * 1000;

type Handler = (job: Job) => Promise<Record<string, unknown>>;

const handlers: Record<JobType, Handler> = {
  analyze_repository: async (job) => {
    const scope = systemScope('job:analyze_repository');
    const projectId = String(job.payload.projectId);
    const project = await db().get(scope, 'projects', projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    await db().update(scope, 'projects', projectId, { status: 'analyzing' });
    const refresh = Boolean(job.payload.refresh);
    try {
      const result = await systemAnalyzeProduct(
        project,
        String(job.payload.repository),
        job.payload.githubToken ? String(job.payload.githubToken) : undefined,
        { refresh },
      );
      await db().update(scope, 'projects', projectId, {
        status: 'analyzed',
        updated_at: nowIso(),
      });
      // Straight to the marketing plan. There is no audience step: the product
      // analysis already carries the target market, the problem solved and the
      // differentiators, so a separate model call to restate them was a stage
      // that could fail without ever adding anything the plan did not have.
      await enqueueOnce(scope, 'generate_strategy', { projectId, refresh }, { projectId });
      return {
        analysisId: result.analysis.id,
        features: result.analysis.features.length,
        costUsd: result.costUsd,
        reused: !result.ran.analysis,
      };
    } catch (e) {
      /*
       * A retry resumes from here, so the status must say what actually
       * survived. Marking the project `failed` outright discarded a completed
       * product analysis in the founder's eyes and sent the next run back to
       * the beginning; `analyzed` is the truth when the analysis is on disk.
       */
      const kept = await getAnalysis(scope, projectId).catch(() => null);
      await db().update(scope, 'projects', projectId, { status: kept ? 'analyzed' : 'failed' });
      throw e;
    }
  },

  generate_strategy: async (job) => {
    const scope = systemScope('job:generate_strategy');
    const projectId = String(job.payload.projectId);
    const project = await db().get(scope, 'projects', projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const analysis = await db().findOne(scope, 'product_analysis', {
      where: { project_id: projectId },
      orderBy: 'created_at',
      direction: 'desc',
    });
    if (!analysis) throw new Error('No product analysis to build a strategy from');
    const personas = await db().find(scope, 'personas', { where: { project_id: projectId } });

    const result = await buildStrategy(scope, project, analysis, personas, {
      refresh: Boolean(job.payload.refresh),
    });
    await db().update(scope, 'projects', projectId, {
      status: 'strategy_ready',
      updated_at: nowIso(),
    });

    /*
     * Full Send means the machine acts. The plan was being saved and then left
     * sitting unapproved, which `generationBlocker` reads as a reason not to
     * write anything — so the pipeline reached step two and stopped, with a
     * finished strategy and an empty calendar.
     */
    if (project.autopilot_mode === 'full_send' && !result.strategy.approved) {
      await db().update(scope, 'marketing_strategies', result.strategy.id, {
        approved: true,
        approved_at: nowIso(),
      });
    }

    // Step three follows step two. Nothing else was enqueuing it, so a founder
    // who never pressed Approve never got content at all.
    await enqueueOnce(scope, 'generate_content', { projectId }, { projectId });

    return {
      strategyId: result.strategy.id,
      pillars: result.pillars.length,
      campaigns: result.campaigns.length,
      costUsd: result.costUsd,
      reused: result.costUsd === 0,
    };
  },

  generate_content: async (job) => {
    const scope = systemScope('job:generate_content');
    const projectId = String(job.payload.projectId);
    const project = await db().get(scope, 'projects', projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const days = Number(job.payload.days ?? 30);
    const result = await topUpContent(
      scope,
      project,
      days,
      job.payload.brief ? String(job.payload.brief) : undefined,
      (job.payload.origin as never) ?? 'initial',
    );

    if (result.generated > 0) {
      await db().update(scope, 'projects', projectId, {
        status: 'content_ready',
        updated_at: nowIso(),
      });
      await enqueueOnce(scope, 'schedule_content', { projectId }, { projectId });
    }
    return { ...result };
  },

  generate_creative: async (job) => {
    // Creative is produced inline with content; this exists for re-renders.
    const scope = systemScope('job:generate_creative');
    const contentId = String(job.payload.contentItemId);
    const item = await db().get(scope, 'content_items', contentId);
    if (!item) throw new Error(`Content ${contentId} not found`);
    return { contentId, assets: item.creative_asset_ids.length };
  },

  quality_control: async (job) => {
    const scope = systemScope('job:quality_control');
    const projectId = String(job.payload.projectId);
    const project = await db().get(scope, 'projects', projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const result = await runDailyAutopilot(projectId);
    return { runId: result.run.id };
  },

  schedule_content: async (job) => {
    const scope = systemScope('job:schedule_content');
    const projectId = String(job.payload.projectId);
    const project = await db().get(scope, 'projects', projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const approved = await db().find(scope, 'content_items', {
      where: { project_id: projectId, status: 'approved' },
    });
    const result = await scheduleContent(scope, project, approved);
    return { scheduled: result.scheduled.length, skipped: result.skipped.length };
  },

  publish_post: async (job) => {
    const scope = systemScope('job:publish_post');
    const outcome = await publishScheduledPost(scope, String(job.payload.scheduledPostId));
    // A retrying publish is not a job failure — the post row carries the state.
    return { status: outcome.status, error: outcome.error ?? null };
  },

  collect_analytics: async (job) => {
    const scope = systemScope('job:collect_analytics');
    return { ...(await collectAnalytics(scope, String(job.payload.projectId))) };
  },

  optimize: async (job) => {
    const scope = systemScope('job:optimize');
    const projectId = String(job.payload.projectId);
    const project = await db().get(scope, 'projects', projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const result = await optimize(scope, project);
    return {
      recommendations: result.recommendations.length,
      applied: result.applied.length,
      postsAnalyzed: result.postsAnalyzed,
    };
  },

  daily_autopilot: async (job) => {
    const result = await runDailyAutopilot(String(job.payload.projectId));
    return {
      runId: result.run.id,
      published: result.published,
      generated: result.generated,
      scheduled: result.scheduled,
      errors: result.errors,
    };
  },

  weekly_report: async (job) => {
    const report = await generateWeeklyReport(String(job.payload.projectId));
    return { reportId: report.id, sendScore: report.send_score.total };
  },

  refresh_tokens: async (job) => {
    const projectId = String(job.payload.projectId);
    const health = await checkAllConnections(projectId);
    return { healthy: health.healthy, needsAttention: health.needsAttention.length };
  },

  scan_trends: async (job) => {
    const scope = systemScope('job:scan_trends');
    const projectId = String(job.payload.projectId);
    const analysis = await db().findOne(scope, 'product_analysis', {
      where: { project_id: projectId },
      orderBy: 'created_at',
      direction: 'desc',
    });
    if (!analysis) return { signals: 0, skipped: 'no analysis' };
    const result = await scanTrends(scope, projectId, analysis);
    return { signals: result.signals.length, participatable: result.participatable.length };
  },
};

export function backoffSeconds(attempt: number): number {
  // 1m, 2m, 4m, 8m, 16m — capped at an hour.
  return Math.min(3600, 60 * 2 ** (attempt - 1));
}

/** Runs one claimed job to completion. Never throws — outcomes are recorded. */
export async function runJob(job: Job): Promise<{ status: 'succeeded' | 'failed' | 'dead' }> {
  const scope = systemScope('job runner');
  const started = Date.now();

  try {
    const handler = handlers[job.type];
    if (!handler) throw new Error(`No handler for job type ${job.type}`);

    const result = await handler(job);
    await db().update(scope, 'jobs', job.id, {
      status: 'succeeded',
      result,
      last_error: null,
      locked_at: null,
      updated_at: nowIso(),
    });
    log.info('job succeeded', { id: job.id, type: job.type, ms: Date.now() - started });
    return { status: 'succeeded' };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const retryable = isFullSendError(e) ? e.retryable : true;
    const exhausted = job.attempts >= job.max_attempts || !retryable;

    if (exhausted) {
      await db().update(scope, 'jobs', job.id, {
        status: 'dead',
        last_error: message,
        locked_at: null,
        updated_at: nowIso(),
      });
      await recordError(scope, {
        projectId: job.project_id,
        scope: `job:${job.type}`,
        message,
        remedy: isFullSendError(e) ? e.remedy : null,
        fatal: true,
      });
      log.error('job dead', { id: job.id, type: job.type, attempts: job.attempts, message });
      return { status: 'dead' };
    }

    const runAfter = new Date(Date.now() + backoffSeconds(job.attempts) * 1000).toISOString();
    await db().update(scope, 'jobs', job.id, {
      status: 'queued',
      last_error: message,
      run_after: runAfter,
      locked_at: null,
      updated_at: nowIso(),
    });

    /*
     * Record it now, not only when the retries run out.
     *
     * This used to be written on death alone, so a job failing its way through
     * five attempts produced nothing anywhere the founder could see: the row
     * reads `queued`, the Send Center only listed fatal errors, and the
     * Control Room was a separate page. With the queue draining every few
     * minutes at best, reaching the fifth attempt takes hours — hours during
     * which an expired key or an empty credit balance is completely invisible
     * and pressing the button again is the only available move.
     *
     * `fatal` stays false while there are attempts left, so it still reads as
     * "retrying" rather than "given up".
     */
    await recordError(scope, {
      projectId: job.project_id,
      scope: `job:${job.type}`,
      message,
      remedy: isFullSendError(e) ? e.remedy : null,
      fatal: false,
    });
    log.warn('job failed, requeued', {
      id: job.id,
      type: job.type,
      attempts: job.attempts,
      runAfter,
      message,
    });
    return { status: 'failed' };
  }
}

/** Drains the queue. `budgetMs` keeps a serverless invocation inside its limit. */
export async function drainQueue(
  opts: { max?: number; budgetMs?: number; projectId?: string | null } = {},
): Promise<{ processed: number; succeeded: number; failed: number; dead: number }> {
  const max = opts.max ?? 20;
  const budgetMs = opts.budgetMs ?? 50_000;
  const deadline = Date.now() + budgetMs;

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let dead = 0;

  while (processed < max && Date.now() < deadline) {
    const job = await db().claimNextJob(nowIso(), LOCK_TIMEOUT_MS, opts.projectId ?? null);
    if (!job) break;
    const { status } = await runJob(job);
    processed++;
    if (status === 'succeeded') succeeded++;
    else if (status === 'dead') dead++;
    else failed++;
  }

  return { processed, succeeded, failed, dead };
}

/** Queue health, for the Control Room. */
export async function queueStats(): Promise<{
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  dead: number;
  oldestQueuedAt: string | null;
}> {
  const scope = systemScope('queue stats');
  const jobs = await db().find(scope, 'jobs', { orderBy: 'created_at', direction: 'asc' });
  const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, dead: 0 };
  let oldestQueuedAt: string | null = null;

  for (const j of jobs) {
    if (j.status in counts) counts[j.status as keyof typeof counts]++;
    if (j.status === 'queued' && !oldestQueuedAt) oldestQueuedAt = j.run_after;
  }
  return { ...counts, oldestQueuedAt };
}

export function cronSecretValid(header: string | null): boolean {
  const expected = env.jobs.cronSecret;
  // With no secret set, cron endpoints are refused rather than left open.
  if (!expected) return false;
  if (!header) return false;
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return token === expected;
}
