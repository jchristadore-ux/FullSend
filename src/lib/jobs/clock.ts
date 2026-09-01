/**
 * The queue's clock.
 *
 * A worker pass claims only the jobs that existed when it began, so the
 * successor a job enqueues is left for the next pass. That boundary is a
 * timestamp, and `Date.now()` has millisecond resolution — a job enqueued in
 * the same millisecond the pass started would be ambiguous, and ambiguity here
 * means an invocation occasionally walking a whole AI chain after all.
 *
 * `queueStamp` never returns the same instant twice in a process, so "created
 * before this pass" is exact. It stays within a millisecond of wall-clock time
 * unless something enqueues thousands of jobs a second, which nothing does.
 */
let last = 0;

export function queueStamp(): string {
  const now = Date.now();
  last = now > last ? now : last + 1;
  return new Date(last).toISOString();
}
