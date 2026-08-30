import 'server-only';
import { type TenantScope } from '../db';
import { db, getSettings, getSocialAccount, listCreativeFor, listScheduled } from '../db/repo';
import { FullSendError } from '../errors';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import { ensurePublicCreative } from '../creative/public-asset';
import { planSlots, type Slot } from '../content/mix';
import type { ContentItem, ContentStatus, MarketingStrategy, Platform, Project, ScheduledPost, Uuid } from '../types';

const log = logger('scheduler');
export const CALENDAR_WINDOWS = [7, 14, 30, 60, 90] as const;
export type CalendarWindow = (typeof CALENDAR_WINDOWS)[number];
export const CONTENT_STATUSES: ContentStatus[] = ['draft', 'approval_required', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'review_required'];

export interface PlanWindowInput { project: Project; strategy: MarketingStrategy; days: CalendarWindow; platforms: Platform[]; from?: Date; }

export async function openSlots(scope: TenantScope, input: PlanWindowInput): Promise<Slot[]> {
  const { project, strategy, days, platforms } = input;
  const from = input.from ?? new Date();
  const settings = await getSettings(scope, project.id);
  const wanted = planSlots({ days, from, strategy, platforms: platforms.filter((p) => p === 'instagram'), dailyCap: settings?.daily_post_cap ?? 3, quietHours: settings?.quiet_hours ?? null });
  const existing = await listScheduled(scope, project.id, { from: from.toISOString(), to: new Date(from.getTime() + days * 86_400_000).toISOString() });
  const taken = new Set(existing.map((p) => `${p.platform}:${p.scheduled_for.slice(0, 13)}`));
  return wanted.filter((s) => !taken.has(`${s.platform}:${s.at.toISOString().slice(0, 13)}`));
}

export interface ScheduleResult { scheduled: ScheduledPost[]; skipped: { contentId: Uuid; reason: string }[]; }

/**
 * A post is not considered schedulable until every required creative asset has
 * a durable public URL. Local SVG is materialised into Supabase Storage here,
 * at the last safe boundary before an Instagram publishing record is created.
 */
export async function scheduleContent(scope: TenantScope, project: Project, items: ContentItem[]): Promise<ScheduleResult> {
  const scheduled: ScheduledPost[] = [];
  const skipped: { contentId: Uuid; reason: string }[] = [];

  for (const item of items) {
    if (item.platform !== 'instagram') { skipped.push({ contentId: item.id, reason: 'Instagram is the only active production platform' }); continue; }
    if (item.status !== 'approved') {
      skipped.push({ contentId: item.id, reason: item.status === 'review_required' ? 'Held for human review by quality control' : item.status === 'approval_required' ? 'Waiting on your approval' : `Status is ${item.status}` });
      continue;
    }
    if (!item.scheduled_for) { skipped.push({ contentId: item.id, reason: 'No scheduled time set' }); continue; }

    const assets = await listCreativeFor(scope, project.id, item.id);
    if (assets.length === 0) { skipped.push({ contentId: item.id, reason: 'Creative is not available yet' }); continue; }
    try {
      for (const asset of assets) {
        const ready = await ensurePublicCreative(asset);
        if (ready.url !== asset.url || ready.storage_path !== asset.storage_path || ready.mime_type !== asset.mime_type) {
          await db().update(scope, 'creative_assets', asset.id, { url: ready.url, storage_path: ready.storage_path, mime_type: ready.mime_type });
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      skipped.push({ contentId: item.id, reason: message });
      continue;
    }

    const account = await getSocialAccount(scope, project.id, 'instagram');
    if (!account || account.status === 'disconnected') log.info('scheduling without a live Instagram connection', { project: project.id });

    const existing = await db().findOne(scope, 'scheduled_posts', { where: { project_id: project.id, content_item_id: item.id } });
    if (existing) { skipped.push({ contentId: item.id, reason: 'Already scheduled' }); continue; }

    const post = await db().insert(scope, 'scheduled_posts', {
      id: newId(), project_id: project.id, content_item_id: item.id, social_account_id: account?.id ?? null,
      platform: 'instagram', scheduled_for: item.scheduled_for, timezone: project.timezone, status: 'scheduled',
      attempts: 0, last_error: null, next_attempt_at: null, created_at: nowIso(),
    });
    await db().update(scope, 'content_items', item.id, { status: 'scheduled', updated_at: nowIso() });
    scheduled.push(post);
  }

  log.info('content scheduled', { project: project.id, scheduled: scheduled.length, skipped: skipped.length });
  return { scheduled, skipped };
}

export async function reschedule(scope: TenantScope, scheduledPostId: Uuid, at: Date): Promise<ScheduledPost> {
  const post = await db().get(scope, 'scheduled_posts', scheduledPostId);
  if (!post) throw new FullSendError('not_found', 'Scheduled post not found', { status: 404 });
  if (post.status === 'published') throw new FullSendError('already_published', 'That post has already gone out', { status: 409, remedy: 'Published posts cannot be rescheduled.' });
  const updated = await db().update(scope, 'scheduled_posts', scheduledPostId, { scheduled_for: at.toISOString(), status: 'scheduled', last_error: null, next_attempt_at: null });
  await db().update(scope, 'content_items', post.content_item_id, { scheduled_for: at.toISOString(), updated_at: nowIso() });
  return updated;
}

export async function unschedule(scope: TenantScope, scheduledPostId: Uuid): Promise<void> {
  const post = await db().get(scope, 'scheduled_posts', scheduledPostId);
  if (!post || post.status === 'published') return;
  await db().remove(scope, 'scheduled_posts', scheduledPostId);
  await db().update(scope, 'content_items', post.content_item_id, { status: 'approved', updated_at: nowIso() });
}

export interface CalendarEntry { scheduledPost: ScheduledPost; content: ContentItem; }
export async function calendar(scope: TenantScope, projectId: Uuid, days: number, from = new Date()): Promise<CalendarEntry[]> {
  const posts = await listScheduled(scope, projectId, { from: from.toISOString(), to: new Date(from.getTime() + days * 86_400_000).toISOString() });
  const entries: CalendarEntry[] = [];
  for (const post of posts) { const content = await db().get(scope, 'content_items', post.content_item_id); if (content) entries.push({ scheduledPost: post, content }); }
  return entries;
}
export async function nextSend(scope: TenantScope, projectId: Uuid): Promise<CalendarEntry | null> {
  const posts = await db().find(scope, 'scheduled_posts', { where: { project_id: projectId }, whereIn: { status: ['scheduled'] }, gte: { scheduled_for: nowIso() }, orderBy: 'scheduled_for', direction: 'asc', limit: 1 });
  const post = posts[0]; if (!post) return null;
  const content = await db().get(scope, 'content_items', post.content_item_id); return content ? { scheduledPost: post, content } : null;
}
export async function queueDepth(scope: TenantScope, projectId: Uuid): Promise<{ queued: number; daysOfRunway: number; lastScheduledAt: string | null }> {
  const upcoming = await db().find(scope, 'scheduled_posts', { where: { project_id: projectId }, whereIn: { status: ['scheduled'] }, gte: { scheduled_for: nowIso() }, orderBy: 'scheduled_for', direction: 'desc' });
  const last = upcoming[0]?.scheduled_for ?? null;
  const daysOfRunway = last ? Math.max(0, Math.ceil((Date.parse(last) - Date.now()) / 86_400_000)) : 0;
  return { queued: upcoming.length, daysOfRunway, lastScheduledAt: last };
}
