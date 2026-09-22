/**
 * Scheduled vs actual publish time, for customer-visible drift.
 *
 * Pure and browser-safe — never invents a lateness figure when either
 * timestamp is missing or unparseable.
 */
export function publishDrift(
  scheduledFor: string | null | undefined,
  publishedAt: string | null | undefined,
): { lateMs: number; label: string } | null {
  if (!scheduledFor || !publishedAt) return null;
  const scheduled = Date.parse(scheduledFor);
  const published = Date.parse(publishedAt);
  if (!Number.isFinite(scheduled) || !Number.isFinite(published)) return null;
  const lateMs = published - scheduled;
  const abs = Math.abs(lateMs);
  const mins = Math.round(abs / 60_000);
  let span: string;
  if (mins < 1) span = 'under a minute';
  else if (mins < 60) span = `${mins}m`;
  else {
    const hours = Math.round(mins / 60);
    span = hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
  }
  if (lateMs > 30_000) return { lateMs, label: `${span} late` };
  if (lateMs < -30_000) return { lateMs, label: `${span} early` };
  return { lateMs, label: 'on time' };
}
