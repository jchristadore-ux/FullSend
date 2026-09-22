/**
 * Whether a job has already failed, whatever its status says.
 *
 * The runner does not mark a retryable failure as failed. It puts the row
 * straight back to `queued` with a backoff and the reason in `last_error`
 * (runner.ts), and only writes `dead` once the attempts run out. So a status
 * check sees `queued` and reports progress — through five attempts, with
 * exponential backoff, on a queue that drains every few minutes at best.
 *
 * `last_error` is what separates the two: a job that has never run has none.
 * An error recorded on a non-succeeded row means it has already failed at
 * least once, and something is wrong now rather than eventually. Do not also
 * require `attempts > 0` — a direct `runJob` (and any path that writes the
 * error without bumping the counter) must still surface as failed rather than
 * as endless progress.
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
  /** When it was last touched. A queue nobody drains leaves this untouched. */
  updatedAt?: string | null;
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
  if (!job) return false;

  if (job.status === 'running') {
    if (!job.lockedAt) return false;
    const claimed = Date.parse(job.lockedAt);
    return Number.isFinite(claimed) && now - claimed > STALE_LOCK_MS;
  }

  return false;
}

/**
 * A job sitting in the queue that no worker has reached yet.
 *
 * This is NOT a failure, and calling it one was its own bug. A queued job with
 * no attempts has not gone wrong — nothing has touched it. What its age
 * measures is how often the queue gets drained, and that is a property of the
 * deployment's scheduler, not of the job.
 *
 * The number matters because the honest answer is uncomfortable: the GitHub
 * Actions heartbeat asks for every five minutes and is actually fired every
 * one to four hours on a quiet repository. Against that, treating six minutes
 * of waiting as death marked healthy work failed, and the onboarding screen
 * stops polling on a failed stage — which stopped the only other thing
 * draining the queue. Waiting was converted into the failure it was mistaken
 * for.
 *
 * So this reports "queued, not yet reached" for the UI to say plainly. Whether
 * anything is draining the queue at all is a deployment-wide question, and it
 * is answered where it can be answered precisely — the Control Room and
 * /api/health — not guessed at from one row's timestamp.
 */
export function isWaitingForWorker(job: JobProgress | null | undefined): boolean {
  if (!job) return false;
  return job.status === 'queued' && (job.attempts ?? 0) === 0 && !job.error;
}

export function hasFailed(job: JobProgress | null | undefined): boolean {
  if (!job) return false;
  if (job.status === 'dead' || job.status === 'failed') return true;
  if (isStalled(job)) return true;
  // last_error is the durable signal. A never-run job has none; a retryable
  // failure requeues with the reason set even when attempts was not persisted.
  return job.status !== 'succeeded' && Boolean(job.error);
}

/** True while the job is genuinely still working and has not failed yet. */
export function stillRunning(job: JobProgress | null | undefined): boolean {
  if (!job) return false;
  return job.status !== 'succeeded' && !hasFailed(job);
}
