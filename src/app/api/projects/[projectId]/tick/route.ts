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
   * Scoped to this project. The queue is global, so a founder watching their
   * own analysis was spending every tick running other projects' jobs — and
   * with a backlog of dead ones from earlier attempts, the job they were
   * actually waiting on was never reached. The page nudges its own work;
   * cron still drains everything.
   */
  return drainQueue({ max: 4, budgetMs: 45_000, projectId: project.id });
});
