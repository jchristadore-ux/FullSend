/**
 * Signed ingest: turning a sibling app's card into a FullSend post.
 *
 * The post is an ordinary content item with one uploaded creative asset, so it
 * appears in the Send Center beside everything else and publishes through the
 * same durable `publish_post` jobs, guard and Instagram adapter. FullSend stays
 * the only place that holds Meta tokens.
 *
 * Idempotency lives in `content_items.dedup_hash` (`ingest:<key>`), which the
 * database already holds unique per project. The same key sent again updates
 * the post in place until it is published; after that it is frozen.
 */
import 'server-only';
import { createHash } from 'node:crypto';
import { systemScope, type TenantScope } from '../db';
import { audit, db, getBrandProfile, getStrategy, listCreativeFor, notify } from '../db/repo';
import { env } from '../env';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import { runQualityControl } from '../qc/check';
import { openSlots, scheduleContent } from '../scheduler/schedule';
import { assertCanUsePosts } from '../billing/enforce';
import { removeStoredObject, uploadBuffer } from '../creative/media';
import type { ContentItem, CreativeAsset, Project, ScheduledPost } from '../types';
import { buildIngestCaption } from './caption';
import { IngestError } from './errors';
import { fetchIngestImage, normalizeIngestImage } from './image';
import type { IngestPost } from './schema';

const log = logger('ingest');

export type IngestStatus = 'draft' | 'scheduled' | 'updated' | 'published';

export interface IngestResult {
  status: IngestStatus;
  post_id: string;
  review_url: string;
}

export interface WithdrawResult {
  status: 'withdrawn';
  post_id: string;
}

/** Side effects the service needs, injectable so tests never touch the network. */
export interface IngestDeps {
  fetchImage(url: string): Promise<Buffer>;
  /** Stores bytes in the creative bucket and returns the public URL. */
  store(path: string, body: Buffer, contentType: string): Promise<string>;
  removeObject(path: string): Promise<void>;
  now(): Date;
}

export const defaultIngestDeps: IngestDeps = {
  fetchImage: fetchIngestImage,
  store: uploadBuffer,
  removeObject: removeStoredObject,
  now: () => new Date(),
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ingestScope(): TenantScope {
  return systemScope('ingest:brovisional');
}

export function dedupHashFor(idempotencyKey: string): string {
  return `ingest:${idempotencyKey}`;
}

export function reviewUrlFor(postId: string): string {
  return `${env.appUrl}/app/content/${postId}`;
}

function keyDigest(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24);
}

/** `project: 'brovisional'` → the FullSend project named by BROVISIONAL_PROJECT_ID. */
export async function resolveIngestProject(scope: TenantScope, project: 'brovisional'): Promise<Project> {
  void project; // one sender today; the enum in the schema is the allow-list
  const id = env.ingest.brovisionalProjectId;
  if (!id || !UUID_RE.test(id)) {
    throw new IngestError(503, 'ingest_not_configured', 'BROVISIONAL_PROJECT_ID is not set to a FullSend project id');
  }
  const found = await db().get(scope, 'projects', id);
  if (!found) {
    throw new IngestError(503, 'ingest_not_configured', 'BROVISIONAL_PROJECT_ID does not match a FullSend project');
  }
  return found;
}

async function findIngested(scope: TenantScope, projectId: string, key: string): Promise<ContentItem | null> {
  return db().findOne(scope, 'content_items', {
    where: { project_id: projectId, dedup_hash: dedupHashFor(key) },
  });
}

type LockState = 'published' | 'in_flight' | 'open';

/**
 * Whether a post may still change.
 *
 * `in_flight` covers a publish that has started or has a container on
 * Instagram: changing the caption then would defeat the publisher's
 * lost-response recovery (it matches by caption) and could double-post.
 */
async function lockState(
  scope: TenantScope,
  item: ContentItem,
): Promise<{ state: LockState; scheduled: ScheduledPost[] }> {
  const scheduled = await db().find(scope, 'scheduled_posts', {
    where: { project_id: item.project_id, content_item_id: item.id },
  });
  const published = await db().findOne(scope, 'published_posts', {
    where: { project_id: item.project_id, content_item_id: item.id },
  });
  if (item.status === 'published' || published || scheduled.some((s) => s.status === 'published')) {
    return { state: 'published', scheduled };
  }
  if (
    item.status === 'publishing' ||
    scheduled.some((s) => s.status === 'publishing' || s.publish_submitted_at || s.platform_container_id)
  ) {
    return { state: 'in_flight', scheduled };
  }
  return { state: 'open', scheduled };
}

/** Removes queued publish jobs and the scheduled rows themselves. */
async function clearSchedule(scope: TenantScope, projectId: string, scheduled: ScheduledPost[]): Promise<void> {
  if (scheduled.length === 0) return;
  const ids = new Set(scheduled.map((s) => s.id));
  const jobs = await db().find(scope, 'jobs', {
    where: { project_id: projectId, type: 'publish_post' },
    whereIn: { status: ['queued'] },
    limit: 200,
  });
  for (const job of jobs) {
    if (ids.has(String(job.payload.scheduledPostId))) {
      await db().update(scope, 'jobs', job.id, {
        status: 'succeeded',
        result: { cancelled: 'withdrawn or replaced by ingest' },
        updated_at: nowIso(),
      });
    }
  }
  for (const s of scheduled) await db().remove(scope, 'scheduled_posts', s.id);
}

async function removeAssets(
  scope: TenantScope,
  deps: IngestDeps,
  assets: CreativeAsset[],
  keepPath?: string,
): Promise<void> {
  for (const asset of assets) {
    await db().remove(scope, 'creative_assets', asset.id);
    if (asset.storage_path && asset.storage_path !== keepPath) await deps.removeObject(asset.storage_path);
  }
}

/** The project's next open calendar slot within a week, else now. */
async function nextSlot(scope: TenantScope, project: Project, now: Date): Promise<Date> {
  try {
    const strategy = await getStrategy(scope, project.id);
    if (!strategy) return now;
    const slots = await openSlots(scope, { project, strategy, days: 7, platforms: ['instagram'], from: now });
    const next = slots.map((s) => s.at).filter((at) => at.getTime() >= now.getTime()).sort((a, b) => a.getTime() - b.getTime())[0];
    return next ?? now;
  } catch (e) {
    log.warn('could not compute next slot; using now', { project: project.id, error: e instanceof Error ? e.message : String(e) });
    return now;
  }
}

function sameInstant(a: string | null, b: string | null | undefined): boolean {
  if (!b) return true; // not specified this time: nothing asked to change
  if (!a) return false;
  return Date.parse(a) === Date.parse(b);
}

export async function ingestPost(payload: IngestPost, deps: IngestDeps = defaultIngestDeps): Promise<IngestResult> {
  const scope = ingestScope();
  const project = await resolveIngestProject(scope, payload.project);
  const key = payload.idempotency_key;
  const existing = await findIngested(scope, project.id, key);

  let previous: { item: ContentItem; scheduled: ScheduledPost[]; assets: CreativeAsset[] } | null = null;
  if (existing) {
    const { state, scheduled } = await lockState(scope, existing);
    if (state === 'published') {
      return { status: 'published', post_id: existing.id, review_url: reviewUrlFor(existing.id) };
    }
    if (state === 'in_flight') {
      throw new IngestError(503, 'publish_in_progress', 'This post is being published right now; retry shortly');
    }
    previous = { item: existing, scheduled, assets: await listCreativeFor(scope, project.id, existing.id) };
  }

  /* The card, copied into our own bucket as an Instagram-ready JPEG. */
  const image = await normalizeIngestImage(await deps.fetchImage(payload.image_url), payload.brand.primary);
  const path = `${project.id}/ingest/${keyDigest(key)}-${image.sourceHash.slice(0, 16)}.jpg`;
  const copy = buildIngestCaption({
    eventType: payload.event_type,
    captionHint: payload.caption_hint,
    facts: payload.facts,
  });

  if (previous) {
    const unchanged =
      previous.assets.length === 1 &&
      previous.assets[0]!.storage_path === path &&
      previous.assets[0]!.alt_text === payload.alt_text &&
      previous.item.caption === copy.caption &&
      sameInstant(previous.item.scheduled_for, payload.scheduled_for);
    if (unchanged) {
      // A retry of what we already hold. Leave it exactly as it is — in
      // particular, do not knock an approved post back to the review queue.
      log.info('ingest repeat with no changes', { project: project.id, key, post: previous.item.id });
      return { status: 'updated', post_id: previous.item.id, review_url: reviewUrlFor(previous.item.id) };
    }
  }

  let publicUrl: string;
  try {
    publicUrl = await deps.store(path, image.jpeg, 'image/jpeg');
  } catch (e) {
    log.error('ingest image upload failed', { project: project.id, key, error: e instanceof Error ? e.message : String(e) });
    throw new IngestError(503, 'storage_unavailable', 'Could not store the image; retry');
  }

  const brand = await getBrandProfile(scope, project.id);
  const qc = runQualityControl({
    item: {
      platform: 'instagram',
      format: 'static',
      hook: copy.hook,
      caption: copy.caption,
      cta: '',
      hashtags: copy.hashtags,
      video_plan: null,
      slides: null,
    },
    // No product analysis: these posts are about rounds, not product claims.
    analysis: null,
    brand,
  });

  const now = deps.now();
  const requested = payload.scheduled_for ? new Date(payload.scheduled_for) : null;
  const when = requested ?? (previous?.item.scheduled_for ? new Date(previous.item.scheduled_for) : await nextSlot(scope, project, now));
  const whenIso = (when.getTime() < now.getTime() ? now : when).toISOString();

  const fields = {
    hook: copy.hook,
    caption: copy.caption,
    cta: '',
    hashtags: copy.hashtags,
    status: 'approval_required' as const,
    generation_state: 'complete' as const,
    generation_error: null,
    qc,
    scheduled_for: whenIso,
    updated_at: nowIso(),
  };

  let item: ContentItem;
  if (previous) {
    await clearSchedule(scope, project.id, previous.scheduled);
    await removeAssets(scope, deps, previous.assets, path);
    item = await db().update(scope, 'content_items', previous.item.id, { ...fields, creative_asset_ids: [] });
  } else {
    try {
      item = await db().insert(scope, 'content_items', {
        id: newId(),
        project_id: project.id,
        campaign_id: null,
        pillar_id: null,
        persona_id: null,
        platform: 'instagram',
        format: 'static',
        script: null,
        video_plan: null,
        slides: null,
        creative_asset_ids: [],
        dedup_hash: dedupHashFor(key),
        published_at: null,
        origin: 'ingest',
        ai_cost_usd: 0,
        created_at: nowIso(),
        ...fields,
      });
    } catch (e) {
      // Almost always the unique (project_id, dedup_hash) index: a concurrent
      // request with the same key won. A retry takes the update path.
      if (await findIngested(scope, project.id, key)) {
        throw new IngestError(503, 'concurrent_request', 'Another request with this idempotency_key is in progress; retry');
      }
      throw e;
    }
  }

  const asset = await db().insert(scope, 'creative_assets', {
    id: newId(),
    project_id: project.id,
    content_item_id: item.id,
    kind: 'image',
    source: 'upload',
    mime_type: 'image/jpeg',
    width: image.width,
    height: image.height,
    url: publicUrl,
    storage_path: path,
    svg: null,
    alt_text: payload.alt_text,
    created_at: nowIso(),
  });
  item = await db().update(scope, 'content_items', item.id, { creative_asset_ids: [asset.id] });

  /* Draft for approval, or straight onto the calendar when the project says so. */
  let scheduled = false;
  let heldReason: string | null = null;
  if (project.ingest_auto_publish === true) {
    if (!qc.passed) {
      heldReason = 'quality control blocked it';
    } else {
      try {
        await assertCanUsePosts(scope, project.user_id, project.id, { action: 'schedule' });
        const approved = await db().update(scope, 'content_items', item.id, { status: 'approved', updated_at: nowIso() });
        const result = await scheduleContent(scope, project, [approved]);
        if (result.scheduled.length > 0) {
          scheduled = true;
        } else {
          heldReason = result.skipped[0]?.reason ?? 'the scheduler skipped it';
          await db().update(scope, 'content_items', item.id, { status: 'approval_required', updated_at: nowIso() });
        }
      } catch (e) {
        heldReason = e instanceof Error ? e.message : String(e);
        await db().update(scope, 'content_items', item.id, { status: 'approval_required', updated_at: nowIso() });
      }
    }
    if (heldReason) log.warn('auto-publish held an ingested post as a draft', { project: project.id, key, reason: heldReason });
  }

  const status: IngestStatus = previous ? 'updated' : scheduled ? 'scheduled' : 'draft';

  if (!previous) {
    await notify(scope, {
      user_id: project.user_id,
      project_id: project.id,
      severity: scheduled ? 'info' : 'warning',
      title: scheduled ? 'A Brovisional post was scheduled' : 'A Brovisional post is waiting for your approval',
      body: scheduled
        ? `Scheduled for ${new Date(whenIso).toUTCString()}.`
        : heldReason
          ? `Auto-publish is on, but it was held: ${heldReason}.`
          : 'Approve it in the Send Center to put it on the calendar.',
      action_label: 'Open the post',
      action_href: `/app/content/${item.id}`,
    }).catch(() => undefined);
  }
  await audit(scope, {
    user_id: project.user_id,
    project_id: project.id,
    action: previous ? 'ingest.post_updated' : 'ingest.post_created',
    target: item.id,
    metadata: { source: 'brovisional', event_type: payload.event_type, idempotency_key: key, group_id: payload.group_id, status },
    ip: null,
  }).catch(() => undefined);

  log.info('ingested post', { project: project.id, key, post: item.id, status, eventType: payload.event_type });
  return { status, post_id: item.id, review_url: reviewUrlFor(item.id) };
}

export async function withdrawPost(idempotencyKey: string, deps: IngestDeps = defaultIngestDeps): Promise<WithdrawResult> {
  const scope = ingestScope();
  const project = await resolveIngestProject(scope, 'brovisional');
  const item = await findIngested(scope, project.id, idempotencyKey);
  if (!item) throw new IngestError(404, 'not_found', 'No post with this idempotency_key (already withdrawn, or never sent)');

  const { state, scheduled } = await lockState(scope, item);
  if (state === 'published') {
    throw new IngestError(409, 'already_published', 'This post is already on Instagram and cannot be withdrawn');
  }
  if (state === 'in_flight') {
    throw new IngestError(409, 'publish_in_progress', 'This post is being published right now and cannot be withdrawn');
  }

  await clearSchedule(scope, project.id, scheduled);
  await removeAssets(scope, deps, await listCreativeFor(scope, project.id, item.id));
  await db().remove(scope, 'content_items', item.id);

  await audit(scope, {
    user_id: project.user_id,
    project_id: project.id,
    action: 'ingest.post_withdrawn',
    target: item.id,
    metadata: { source: 'brovisional', idempotency_key: idempotencyKey },
    ip: null,
  }).catch(() => undefined);
  log.info('withdrew ingested post', { project: project.id, key: idempotencyKey, post: item.id });
  return { status: 'withdrawn', post_id: item.id };
}
