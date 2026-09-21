/** Status chip styling, shared by every list that shows content state. */
export const STATUS_STYLE: Record<string, string> = {
  draft: 'border-edge text-dim',
  approval_required: 'border-warn/50 text-warn',
  approved: 'border-live/40 text-live',
  scheduled: 'border-orange/50 text-orange',
  /** Retrying after a visible failure — never looks like a clean schedule. */
  retrying: 'border-fail/50 bg-fail/10 text-fail',
  publishing: 'border-orange text-orange',
  published: 'border-live/60 bg-live/10 text-live',
  failed: 'border-fail/60 bg-fail/10 text-fail',
  review_required: 'border-fail/50 text-fail',
};

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  approval_required: 'Approval required',
  approved: 'Approved',
  scheduled: 'Scheduled',
  retrying: 'Retrying',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Failed',
  review_required: 'Review required',
};

/**
 * Customer-facing publish status.
 *
 * A post that failed and is waiting to retry stays `scheduled` in the database
 * (so the publish cron still picks it up), but must never look like a clean
 * "Scheduled" chip with no failure. Attempts + last_error → Retrying.
 */
export function publishDisplayStatus(opts: {
  status: string;
  lastError?: string | null;
  attempts?: number;
}): string {
  if (
    opts.status === 'scheduled' &&
    (opts.attempts ?? 0) > 0 &&
    Boolean(opts.lastError)
  ) {
    return 'retrying';
  }
  return opts.status;
}
