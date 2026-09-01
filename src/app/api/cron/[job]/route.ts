import { NextResponse, type NextRequest } from 'next/server';
import { errorResponse } from '@/lib/api/handler';
import { FullSendError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { systemScope } from '@/lib/db';
import { db, enqueue } from '@/lib/db/repo';
import { cronSecretValid, drainQueue } from '@/lib/jobs/runner';
import { enqueueDuePublishJobs, projectsForAutopilot } from '@/lib/automation/autopilot';
import { sweep } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Well inside `maxDuration`, with room for a job that started just under the
 * line to finish and write its result. A worker pass that gets killed leaves a
 * job locked until its lease expires; leaving margin is cheaper than recovery.
 */
const DRAIN_BUDGET_MS = 200_000;

const log = logger('cron');

/**
 * The background heartbeat. Vercel Cron (or any scheduler) hits these; the
 * founder's browser is never involved.
 *
 *   /api/cron/queue     — drain the job queue          (every minute)
 *   /api/cron/publish   — publish anything due         (every 5 minutes)
 *   /api/cron/daily     — the full autopilot loop      (daily)
 *   /api/cron/weekly    — the Weekly Send Report       (weekly)
 *   /api/cron/health    — token refresh + connections  (every 6 hours)
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ job: string }> },
): Promise<NextResponse> {
  return handle(req, ctx);
}

// Vercel Cron issues GETs; both verbs are accepted, both are authenticated.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ job: string }> },
): Promise<NextResponse> {
  return handle(req, ctx);
}

async function handle(
  req: NextRequest,
  ctx: { params: Promise<{ job: string }> },
): Promise<NextResponse> {
  const { job } = await ctx.params;

  try {
    const authorized =
      cronSecretValid(req.headers.get('authorization')) ||
      cronSecretValid(req.headers.get('x-cron-secret'));

    if (!authorized) {
      // Refuse rather than run open: an unsecured cron endpoint is a way in.
      throw new FullSendError('unauthorized', 'Invalid or missing cron secret', {
        status: 401,
        remedy: 'Set CRON_SECRET and send it as `Authorization: Bearer <secret>`.',
      });
    }

    sweep();
    const started = Date.now();
    const result = await runCronJob(job);
    log.info('cron completed', { job, ms: Date.now() - started, ...result });
    return NextResponse.json({ job, ok: true, ...result });
  } catch (e) {
    return errorResponse(e, req);
  }
}

async function runCronJob(job: string): Promise<Record<string, unknown>> {
  const scope = systemScope(`cron:${job}`);

  /*
   * Every branch here is the same shape: write durable jobs, then run one
   * bounded worker pass. Nothing publishes or calls an AI provider inline, so
   * no request can outlive its own invocation — `drainQueue` stops at the
   * first expensive job and the next heartbeat picks up where it left off.
   */
  switch (job) {
    case 'queue':
      return { ...(await drainQueue({ max: 25, budgetMs: DRAIN_BUDGET_MS })) };

    case 'publish': {
      const queued = await enqueueDuePublishJobs(50);
      const drained = await drainQueue({ max: 5, budgetMs: DRAIN_BUDGET_MS });
      return { ...queued, ...drained };
    }

    case 'daily': {
      const projects = await projectsForAutopilot();
      // Enqueued rather than run inline so one slow project cannot starve the rest.
      for (const p of projects) {
        await enqueue(scope, 'daily_autopilot', { projectId: p.id }, { projectId: p.id });
      }
      const drained = await drainQueue({ max: 12, budgetMs: DRAIN_BUDGET_MS });
      return { projects: projects.length, ...drained };
    }

    case 'weekly': {
      const projects = await projectsForAutopilot();
      for (const p of projects) {
        await enqueue(scope, 'weekly_report', { projectId: p.id }, { projectId: p.id });
      }
      const drained = await drainQueue({ max: 12, budgetMs: DRAIN_BUDGET_MS });
      return { projects: projects.length, ...drained };
    }

    case 'health': {
      const projects = await db().find(scope, 'projects', {});
      for (const p of projects) {
        if (p.status === 'created') continue;
        await enqueue(scope, 'refresh_tokens', { projectId: p.id }, { projectId: p.id });
      }
      const drained = await drainQueue({ max: 25, budgetMs: 120_000 });
      return { projects: projects.length, ...drained };
    }

    default:
      throw new FullSendError('unknown_job', `No cron job named "${job}"`, {
        status: 404,
        remedy: 'Valid jobs: queue, publish, daily, weekly, health.',
      });
  }
}
