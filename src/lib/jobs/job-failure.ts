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
  /** When a worker claimed it. A claim older than the lock timeout is dead. */
  lockedAt?: string | null;
}

/**
 * How long a claim is honoured before the worker holding it is presumed dead.
 * Matches the runner's own lock timeout: these two must agree, or the queue
 * reclaims a job the UI still calls running, or the reverse.
 */
export const STALE_LOCK_MS = 3 * 60 * 1000;

/**
 * A job whose worker died mid-run.
 *
 * This is the deadlock that made Retry do nothing. A serverless invocation
 * killed at sixty seconds leaves `status: 'running'` and a claim nobody
 * releases. Everything downstream then read that row as work in progress: the
 * pipeline showed a spinner with no button under it, and `enqueueOnce` refused
 * to start the stage again because a copy was supposedly already in flight.
 * Nothing was running. Nothing could be started. It stayed that way.
 */
export function isStalled(job: JobProgress | null | undefined, now = Date.now()): boolean {
  if (!job || job.status !== 'running') return false;
  if (!job.lockedAt) return false;
  const claimed = Date.parse(job.lockedAt);
  return Number.isFinite(claimed) && now - claimed > STALE_LOCK_MS;
}

export function hasFailed(job: JobProgress | null | undefined): boolean {
  if (!job) return false;
  if (job.status === 'dead' || job.status === 'failed') return true;
  if (isStalled(job)) return true;
  return job.status !== 'succeeded' && (job.attempts ?? 0) > 0 && Boolean(job.error);
}

/** True while the job is genuinely still working and has not failed yet. */
export function stillRunning(job: JobProgress | null | undefined): boolean {
  if (!job) return false;
  return job.status !== 'succeeded' && !hasFailed(job);
}
