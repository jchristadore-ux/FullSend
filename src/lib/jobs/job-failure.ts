/**
 * Whether a job has already failed, whatever its status says.
 *
 * The runner does not mark a retryable failure as failed. It puts the row
 * straight back to `queued` with a backoff and the reason in `last_error`
 * (runner.ts), and only writes `dead` once the attempts run out. So a status
 * check sees `queued` and reports progress — through five attempts, with
 * exponential backoff, on a queue that drains every few minutes at best.
 *
 * `attempts` is what separates the two: a job that has never run has none.
 * Non-zero attempts with an error recorded means it has already failed at
 * least once, and something is wrong now rather than eventually.
 *
 * Shared, because this was fixed once on the calendar and the onboarding
 * screen went on spinning on "Reading repository" with the answer sitting
 * unread on the same row.
 */

export interface JobProgress {
  status?: string;
  attempts?: number;
  error?: string | null;
}

export function hasFailed(job: JobProgress | null | undefined): boolean {
  if (!job) return false;
  if (job.status === 'dead' || job.status === 'failed') return true;
  return job.status !== 'succeeded' && (job.attempts ?? 0) > 0 && Boolean(job.error);
}

/** True while the job is genuinely still working and has not failed yet. */
export function stillRunning(job: JobProgress | null | undefined): boolean {
  if (!job) return false;
  return job.status !== 'succeeded' && !hasFailed(job);
}
