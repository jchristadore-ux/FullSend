import { projectRoute } from '@/lib/api/handler';
import { drainQueue } from '@/lib/jobs/runner';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Nudges the job queue while a user is watching.
 *
 * Cron owns the queue in normal operation; this exists so onboarding isn't
 * waiting on the next scheduled tick, and so a local dev run works with no
 * scheduler at all. It only ever drains jobs that are already queued — it
 * cannot create work, and the caller must own the project.
 */
export const POST = projectRoute(async ({ project }) => {
  /*
   * Run at most one job per user-facing tick. AI work can legitimately consume
   * most of a function invocation, so claiming a second job is unsafe and can
   * leave both the worker and the browser without a clean completion signal.
   * Cron remains responsible for draining the rest of the queue.
   */
  return drainQueue({ max: 1, budgetMs: 55_000, projectId: project.id });
});
