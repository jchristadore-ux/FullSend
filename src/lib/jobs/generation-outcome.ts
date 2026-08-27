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

export interface GenerationJob {
  status?: string;
  error?: string | null;
  result?: {
    generated?: number;
    rejectedDuplicates?: number;
    blockedByQc?: number;
    reason?: string;
  } | null;
}

export function describeGenerationOutcome(job: GenerationJob, days: number): string {
  if (job.status === 'failed' || job.status === 'dead') {
    return job.error ?? 'That run failed. The Control Room at /admin has the details.';
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

  // Finished, made nothing, and knows why. Say which, and what to do about it.
  const reason = job.result?.reason;
  if (!reason) return `Nothing new to add for the next ${days} days. Try a longer window.`;
  return `Nothing new to add: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}. Try a longer window.`;
}
