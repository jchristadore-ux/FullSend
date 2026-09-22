/**
 * Reclaim scheduled posts left stuck in `publishing` after a worker died.
 */
import 'server-only';
import { type TenantScope } from '../db';
import { db, notify, recordError } from '../db/repo';
import { STALE_LOCK_MS } from '../jobs/job-failure';
import { logger } from '../logger';

const log = logger('publish-reclaim');

/**
 * Posts left in `publishing` after a worker died mid-flight.
 *
 * A serverless kill leaves status=`publishing` with no lock on the scheduled
 * row itself — only the job lease. Without reclaim, the calendar shows
 * "Publishing" forever and nothing retries. Anything stuck past the same
 * window as a stale job lease is failed with an actionable error (retryable
 * via the calendar / reconnect paths), never left as a silent schedule.
 */
export async function reclaimStalePublishing(
  scope: TenantScope,
  now = Date.now(),
): Promise<number> {
  const stuck = await db().find(scope, 'scheduled_posts', {
    where: { status: 'publishing' },
    limit: 50,
  });
  let reclaimed = 0;
  for (const post of stuck) {
    const started = Date.parse(post.started_at ?? post.scheduled_for);
    if (!Number.isFinite(started) || now - started < STALE_LOCK_MS) continue;

    const project = await db().get(scope, 'projects', post.project_id);
    const content = await db().get(scope, 'content_items', post.content_item_id);
    const message =
      'Publish was interrupted before Instagram confirmed it. FullSend marked it failed so it is not stuck as "scheduled" or "publishing".';
    const remedy =
      'Open the calendar and retry, or wait for the next reconnect/resume if the connection was the problem.';

    await db().update(scope, 'scheduled_posts', post.id, {
      status: 'failed',
      last_error: message,
      next_attempt_at: null,
    });
    if (content) {
      await db().update(scope, 'content_items', content.id, { status: 'failed' });
    }
    if (project) {
      await recordError(scope, {
        projectId: project.id,
        scope: `publish:${post.platform}`,
        message,
        remedy,
        fatal: false,
      });
      await notify(scope, {
        user_id: project.user_id,
        project_id: project.id,
        severity: 'error',
        title: `A ${post.platform} publish stalled`,
        body: `${message} — ${remedy}`,
        action_label: 'Open the calendar',
        action_href: '/app/calendar',
      });
    }
    reclaimed++;
    log.warn('reclaimed stale publishing post', { postId: post.id, ageMs: now - started });
  }
  return reclaimed;
}
