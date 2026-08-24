/** Status chip styling, shared by every list that shows content state. */
export const STATUS_STYLE: Record<string, string> = {
  draft: 'border-edge text-dim',
  approval_required: 'border-warn/50 text-warn',
  approved: 'border-live/40 text-live',
  scheduled: 'border-orange/50 text-orange',
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
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Failed',
  review_required: 'Review required',
};
