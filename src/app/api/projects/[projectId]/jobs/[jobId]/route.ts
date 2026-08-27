/**
 * What became of one queued job.
 *
 * Work happens in the background, so the browser that started it has no idea
 * how it went. Without this, an action that finished and deliberately produced
 * nothing — a calendar already full for the window asked for, every candidate
 * caught by the duplicate check — is indistinguishable from one that is still
 * running or silently broken. The job already records its reason; this hands
 * it back.
 */
import { projectRoute } from '@/lib/api/handler';
import { db } from '@/lib/db/repo';
import { FullSendError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = projectRoute(async ({ project, params, session }) => {
  const job = await db().get(session.scope, 'jobs', params.jobId);

  // Scoped to the project in the URL, so a job id cannot be used to read
  // across projects even within one account.
  if (!job || job.project_id !== project.id) {
    throw new FullSendError('not_found', 'Job not found', { status: 404 });
  }

  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    result: job.result ?? null,
    error: job.last_error ?? null,
  };
});
