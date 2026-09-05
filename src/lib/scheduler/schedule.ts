import 'server-only';
import { env } from '../env';
import { type TenantScope } from '../db';
import { db, getSettings, getSocialAccount, listCreativeFor, listScheduled } from '../db/repo';
import { FullSendError } from '../errors';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import { ensurePublicCreative } from '../creative/media';
import { planSlots, type Slot } from '../content/mix';
import type { ContentItem, ContentStatus, MarketingStrategy, Platform, Project, ScheduledPost, Uuid } from '../types';
const log = logger('scheduler');
export const CALENDAR_WINDOWS = [7, 14, 30, 60, 90] as const;
export type CalendarWindow = (typeof CALENDAR_WINDOWS)[number];
export const CONTENT_STATUSES: ContentStatus[] = ['draft', 'approval_required', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'review_required'];
export interface PlanWindowInput { project: Project; strategy: MarketingStrategy; days: CalendarWindow; platforms: Platform[]; from?: Date; }
/**
 * The slots in the window that nothing has been written for yet.
 *
 * A slot counts as taken once *content* exists for it, not only once that
 * content has been scheduled. Content is written in batches of six, so a
 * thirty-post calendar takes several jobs; without this, every batch after the
 * first would be handed the same slots again and write the same days twice.
 * It is also what makes pressing Generate again harmless.
 */
export async function openSlots(scope: TenantScope, input: PlanWindowInput): Promise<Slot[]> {
  const { project, strategy, days, platforms } = input;
  const from = input.from ?? new Date();
  const to = new Date(from.getTime() + days * 86_400_000);
  const settings = await getSettings(scope, project.id);
  const wanted = planSlots({ days, from, strategy, platforms: platforms.filter((p) => p === 'instagram'), dailyCap: settings?.daily_post_cap ?? 3, quietHours: settings?.quiet_hours ?? null });

  const scheduled = await listScheduled(scope, project.id, { from: from.toISOString(), to: to.toISOString() });
  const written = await db().find(scope, 'content_items', { where: { project_id: project.id }, gte: { scheduled_for: from.toISOString() }, lt: { scheduled_for: to.toISOString() }, limit: 500 });

  const hour = (platform: string, at: string) => `${platform}:${at.slice(0, 13)}`;
  const taken = new Set<string>([
    ...scheduled.map((p) => hour(p.platform, p.scheduled_for)),
    ...written.filter((c) => c.scheduled_for).map((c) => hour(c.platform, c.scheduled_for!)),
  ]);
  return wanted.filter((s) => !taken.has(hour(s.platform, s.at.toISOString())));
}
export interface ScheduleResult { scheduled: ScheduledPost[]; skipped: { contentId: Uuid; reason: string }[]; }
export async function scheduleContent(scope: TenantScope, project: Project, items: ContentItem[]): Promise<ScheduleResult> {
  const scheduled: ScheduledPost[] = []; const skipped: { contentId: Uuid; reason: string }[] = [];
  for (const item of items) {
    if (item.platform !== 'instagram') { skipped.push({ contentId: item.id, reason: 'Instagram is the only active production platform' }); continue; }
    if (item.status !== 'approved') { skipped.push({ contentId: item.id, reason: item.status === 'review_required' ? 'Held for human review by quality control' : item.status === 'approval_required' ? 'Waiting on your approval' : `Status is ${item.status}` }); continue; }
    if (!item.scheduled_for) { skipped.push({ contentId: item.id, reason: 'No scheduled time set' }); continue; }
    /*
     * Only schedule posts whose copy and creative are finished. Anything still
     * generating (or failed) is skipped — unfinished creative used to reach a
     * real calendar as blank images. The asset check below is the second line.
     */
    if (item.generation_state !== 'complete' && item.generation_state !== 'creative_complete') {
      skipped.push({
        contentId: item.id,
        reason:
          item.generation_state === 'failed'
            ? (item.generation_error ?? 'The creative for this post could not be produced')
            : `Generation is not finished (state: ${item.generation_state}). Wait until copy and creative are complete, or regenerate creative.`,
      });
      continue;
    }
    const assets = await listCreativeFor(scope, project.id, item.id); if (assets.length === 0) { skipped.push({ contentId: item.id, reason: 'Creative is not available yet' }); continue; }
    if (env.nodeEnv !== 'test') {
      try { for (const asset of assets) await ensurePublicCreative(scope, asset); }
      catch (e) { skipped.push({ contentId: item.id, reason: e instanceof Error ? e.message : String(e) }); continue; }
    }
    /*
     * The destination is recorded here, at scheduling time, and the publisher
     * treats it as binding from then on. Connecting a different Instagram
     * account to this project later must not move posts that were already
     * queued — see publish/guard.ts.
     *
     * Scheduling without a connection is still allowed: building the calendar
     * is step three and connecting an account is step four, and Meta's review
     * can take weeks. Such a post gets its destination pinned on the first
     * publish attempt instead, and until then the calendar is honest that
     * nothing is connected.
     */
    const account = await getSocialAccount(scope, project.id, 'instagram'); if (!account || account.status === 'disconnected') log.info('scheduling without a live Instagram connection', { project: project.id });
    const existing = await db().findOne(scope, 'scheduled_posts', { where: { project_id: project.id, content_item_id: item.id } }); if (existing) { skipped.push({ contentId: item.id, reason: 'Already scheduled' }); continue; }
    const post = await db().insert(scope, 'scheduled_posts', { id: newId(), project_id: project.id, content_item_id: item.id, social_account_id: account?.id ?? null, platform: 'instagram', scheduled_for: item.scheduled_for, timezone: project.timezone, status: 'scheduled', attempts: 0, last_error: null, next_attempt_at: null, created_at: nowIso(), started_at: null, platform_container_id: null, publish_submitted_at: null, published_at: null });
    await db().update(scope, 'content_items', item.id, { status: 'scheduled', updated_at: nowIso() }); scheduled.push(post);
  }
  log.info('content scheduled', { project: project.id, scheduled: scheduled.length, skipped: skipped.length }); return { scheduled, skipped };
}
export async function reschedule(scope: TenantScope, scheduledPostId: Uuid, at: Date): Promise<ScheduledPost> { const post = await db().get(scope, 'scheduled_posts', scheduledPostId); if (!post) throw new FullSendError('not_found', 'Scheduled post not found', { status: 404 }); if (post.status === 'published') throw new FullSendError('already_published', 'That post has already gone out', { status: 409, remedy: 'Published posts cannot be rescheduled.' }); const updated = await db().update(scope, 'scheduled_posts', scheduledPostId, { scheduled_for: at.toISOString(), status: 'scheduled', last_error: null, next_attempt_at: null }); await db().update(scope, 'content_items', post.content_item_id, { scheduled_for: at.toISOString(), updated_at: nowIso() }); return updated; }
export async function unschedule(scope: TenantScope, scheduledPostId: Uuid): Promise<void> { const post = await db().get(scope, 'scheduled_posts', scheduledPostId); if (!post || post.status === 'published') return; await db().remove(scope, 'scheduled_posts', scheduledPostId); await db().update(scope, 'content_items', post.content_item_id, { status: 'approved', updated_at: nowIso() }); }
export interface CalendarEntry { scheduledPost: ScheduledPost; content: ContentItem; }
export async function calendar(scope: TenantScope, projectId: Uuid, days: number, from = new Date()): Promise<CalendarEntry[]> { const posts = await listScheduled(scope, projectId, { from: from.toISOString(), to: new Date(from.getTime() + days * 86_400_000).toISOString() }); const entries: CalendarEntry[] = []; for (const post of posts) { const content = await db().get(scope, 'content_items', post.content_item_id); if (content) entries.push({ scheduledPost: post, content }); } return entries; }
export async function nextSend(scope: TenantScope, projectId: Uuid): Promise<CalendarEntry | null> { const posts = await db().find(scope, 'scheduled_posts', { where: { project_id: projectId }, whereIn: { status: ['scheduled'] }, gte: { scheduled_for: nowIso() }, orderBy: 'scheduled_for', direction: 'asc', limit: 1 }); const post = posts[0]; if (!post) return null; const content = await db().get(scope, 'content_items', post.content_item_id); return content ? { scheduledPost: post, content } : null; }
export async function queueDepth(scope: TenantScope, projectId: Uuid): Promise<{ queued: number; daysOfRunway: number; lastScheduledAt: string | null }> { const upcoming = await db().find(scope, 'scheduled_posts', { where: { project_id: projectId }, whereIn: { status: ['scheduled'] }, gte: { scheduled_for: nowIso() }, orderBy: 'scheduled_for', direction: 'desc' }); const last = upcoming[0]?.scheduled_for ?? null; const daysOfRunway = last ? Math.max(0, Math.ceil((Date.parse(last) - Date.now()) / 86_400_000)) : 0; return { queued: upcoming.length, daysOfRunway, lastScheduledAt: last }; }
