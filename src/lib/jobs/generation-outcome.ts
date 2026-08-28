/**
 * What a generation run did, in the founder's words.
 *
 * A run can finish having deliberately produced nothing: the window asked for
 * is already full, or every candidate repeated something written before. That
 * is a real answer and it needs saying. Reporting it as "refresh in a moment"
 * is what makes a working button look broken — the refresh shows exactly what
 * was there before, and there is nothing to explain why.
 *
 * Pure, and free of server-only imports, so the browser can use it and a test
 * can pin what each outcome reads as.
 */

import { longerWindowHelps } from '../content/blockers';
import { hasFailed } from './job-failure';

export interface GenerationJob {
  status?: string;
  error?: string | null;
  /** How many times it has already been tried. Non-zero means it has failed. */
  attempts?: number;
  result?: {
    generated?: number;
    rejectedDuplicates?: number;
    blockedByQc?: number;
    reason?: string;
  } | null;
}

export function describeGenerationOutcome(job: GenerationJob, days: number): string {
  /*
   * A retryable failure does not leave the job marked failed — `hasFailed`
   * carries that rule, shared with the onboarding screen so the two cannot
   * disagree about whether a job is slow or broken.
   */
  if (hasFailed(job)) {
    const reason = job.error ?? 'The Control Room at /admin has the details.';
    return job.status === 'dead' ? reason : `That run failed and will retry: ${reason}`;
  }
  if (job.status !== 'succeeded') {
    return `Still working on a ${days}-day calendar — refresh in a moment.`;
  }

  const made = job.result?.generated ?? 0;
  if (made > 0) {
    const held = job.result?.blockedByQc ?? 0;
    const posts = made === 1 ? '1 post' : `${made} posts`;
    return held > 0 ? `Wrote ${posts}. ${held} held for your review.` : `Wrote ${posts}.`;
  }

  /*
   * Finished, made nothing, and knows why.
   *
   * "Try a longer window" only belongs where a longer window is genuinely the
   * remedy. Appending it to every reason told someone whose strategy was
   * unapproved to press the same button again with a bigger number — advice
   * that cannot work, offered in place of the one thing that would.
   */
  const reason = job.result?.reason;
  if (!reason) return `Nothing new to add for the next ${days} days. Try a longer window.`;

  const sentence = `Nothing new to add: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.`;
  return longerWindowHelps(reason) ? `${sentence} Try a longer window.` : sentence;
}
