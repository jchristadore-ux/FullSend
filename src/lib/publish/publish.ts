/**
 * The publisher.
 *
 * Takes a due scheduled post, re-runs quality control against it, resolves
 * public media URLs, calls the platform adapter, and records the receipt. Every
 * failure produces either a retry with backoff or an actionable error the
 * founder can see — nothing is ever dropped quietly.
 */
import 'server-only';
import { env } from '../env';
import { type TenantScope } from '../db';
import { audit, db, notify, recordError } from '../db/repo';
import { FullSendError, isFullSendError } from '../errors';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import { publicUrlsFor } from '../creative/media';
import { runQualityControl } from '../qc/check';
import { getUsableConnection, markNeedsAttention } from '../social/connections';
import { getAdapter } from '../social/registry';
import type {
  ContentItem,
  Project,
  PublishedPost,
  ScheduledPost,
  Uuid,
} from '../types';

const log = logger('publish');

/** Exponential backoff with a cap, so a broken platform isn't hammered. */
export function backoffMs(attempt: number): number {
  return Math.min(6 * 60 * 60 * 1000, 2 ** attempt * 60_000);
}

export interface PublishOutcome {
  status: 'published' | 'retrying' | 'failed' | 'blocked';
  publishedPost?: PublishedPost;
  error?: string;
  remedy?: string | null;
  nextAttemptAt?: string | null;
}

export async function publishScheduledPost(
  scope: TenantScope,
  scheduledPostId: Uuid,
): Promise<PublishOutcome> {
  const post = await db().get(scope, 'scheduled_posts', scheduledPostId);
  if (!post) throw new FullSendError('not_found', 'Scheduled post not found', { status: 404 });

  const project = await db().get(scope, 'projects', post.project_id);
  const content = await db().get(scope, 'content_items', post.content_item_id);
  if (!project || !content) {
    return finalizeFailure(scope, post, 'The post or its project no longer exists', null);
  }
  if (post.status === 'published') {
    return { status: 'published' };
  }

  await db().update(scope, 'scheduled_posts', post.id, { status: 'publishing' });
  await db().update(scope, 'content_items', content.id, { status: 'publishing' });

  try {
    // QC runs again at publish time: content or brand may have changed since.
    const analysis = await db().findOne(scope, 'product_analysis', {
      where: { project_id: project.id },
      orderBy: 'created_at',
      direction: 'desc',
    });
    const brand = await db().findOne(scope, 'brand_profiles', {
      where: { project_id: project.id },
    });

    const qc = runQualityControl({ item: content, analysis, brand });
    if (!qc.passed) {
      await db().update(scope, 'content_items', content.id, {
        status: 'review_required',
        qc,
        updated_at: nowIso(),
      });
      await db().update(scope, 'scheduled_posts', post.id, {
        status: 'review_required',
        last_error: 'Quality control blocked this post at publish time',
      });
      await notify(scope, {
        user_id: project.user_id,
        project_id: project.id,
        severity: 'warning',
        title: 'A post was held back',
        body: `"${content.hook.slice(0, 70)}" did not pass quality control: ${qc.findings.find((f) => f.severity === 'block')?.message ?? 'blocked'}`,
        action_label: 'Review it',
        action_href: `/app/content/${content.id}`,
      });
      return { status: 'blocked', error: 'Quality control blocked this post' };
    }

    const connection = await getUsableConnection(scope, project.id, post.platform);
    const adapter = getAdapter(post.platform);

    const media = await publicUrlsFor(scope, project.id, content.creative_asset_ids);
    const videoUrl = content.video_plan?.rendered_url ?? media.video;

    if (needsVideo(content.format) && !videoUrl) {
      return finalizeFailure(
        scope,
        post,
        'This post needs a rendered video file and none exists yet',
        'FullSend produced the full production package. Shoot or upload the video, or set ' +
          'FULLSEND_VIDEO_PROVIDER to render it automatically.',
        project,
        content,
      );
    }

    const result = await adapter.publish(connection.tokens, connection.info, {
      caption: buildCaption(content),
      format: content.format,
      mediaUrls: media.images,
      videoUrl,
      coverUrl: media.cover,
      shareToFeed: true,
    });

    const publishedAt = nowIso();
    const publishedPost = await db().insert(scope, 'published_posts', {
      id: newId(),
      project_id: project.id,
      content_item_id: content.id,
      scheduled_post_id: post.id,
      social_account_id: connection.account.id,
      platform: post.platform,
      external_id: result.externalId,
      permalink: result.permalink,
      published_at: publishedAt,
      platform_response: result.raw,
    });

    await db().update(scope, 'scheduled_posts', post.id, {
      status: 'published',
      last_error: null,
      next_attempt_at: null,
    });
    await db().update(scope, 'content_items', content.id, {
      status: 'published',
      published_at: publishedAt,
      updated_at: publishedAt,
    });

    await audit(scope, {
      user_id: project.user_id,
      project_id: project.id,
      action: 'post.published',
      target: `${post.platform}:${result.externalId}`,
      metadata: { contentId: content.id, permalink: result.permalink },
      ip: null,
    });

    // TikTok tells us when a post is restricted; pass that through honestly.
    if (result.raw?.visibility_restricted) {
      await notify(scope, {
        user_id: project.user_id,
        project_id: project.id,
        severity: 'warning',
        title: 'Posted to TikTok, but private',
        body:
          `"${content.hook.slice(0, 60)}" was published as SELF_ONLY. ` +
          String(result.raw.restriction_reason ?? ''),
        action_label: 'How to fix this',
        action_href: '/app/accounts/tiktok/setup',
      });
    }

    log.info('post published', {
      project: project.id,
      platform: post.platform,
      externalId: result.externalId,
    });
    return { status: 'published', publishedPost };
  } catch (e) {
    return handlePublishError(scope, post, project, content, e);
  }
}

function needsVideo(format: string): boolean {
  return format === 'reel' || format === 'short_video' || format === 'story';
}

/** Caption plus hashtags, in the shape each platform expects. */
export function buildCaption(item: ContentItem): string {
  const tags = item.hashtags.filter(Boolean).join(' ');
  if (!tags) return item.caption;
  return `${item.caption}\n\n${tags}`.slice(0, 2200);
}

async function handlePublishError(
  scope: TenantScope,
  post: ScheduledPost,
  project: Project,
  content: ContentItem,
  e: unknown,
): Promise<PublishOutcome> {
  const err = isFullSendError(e)
    ? e
    : new FullSendError('publish_failed', String(e), { retryable: true });

  const attempts = post.attempts + 1;
  const maxAttempts = env.jobs.maxAttempts;

  // A dead connection is not a retry problem — it needs the founder.
  const needsAttention = Boolean(err.meta?.needsAttention) || err.code === 'connection_error';
  if (needsAttention) {
    const account = post.social_account_id
      ? await db().get(scope, 'social_accounts', post.social_account_id)
      : null;
    if (account) await markNeedsAttention(scope, account, err.message);

    await db().update(scope, 'scheduled_posts', post.id, {
      status: 'failed',
      attempts,
      last_error: err.message,
      // Held, not abandoned: it goes out once the connection is restored.
      next_attempt_at: null,
    });
    await db().update(scope, 'content_items', content.id, { status: 'failed' });
    await recordError(scope, {
      projectId: project.id,
      scope: `publish:${post.platform}`,
      message: err.message,
      remedy: err.remedy,
      fatal: false,
    });
    return { status: 'failed', error: err.message, remedy: err.remedy };
  }

  if (err.retryable && attempts < maxAttempts) {
    const nextAttemptAt = new Date(Date.now() + backoffMs(attempts)).toISOString();
    await db().update(scope, 'scheduled_posts', post.id, {
      status: 'scheduled',
      attempts,
      last_error: err.message,
      next_attempt_at: nextAttemptAt,
      scheduled_for: nextAttemptAt,
    });
    await db().update(scope, 'content_items', content.id, { status: 'scheduled' });
    log.warn('publish failed, will retry', {
      project: project.id,
      platform: post.platform,
      attempts,
      nextAttemptAt,
      error: err.message,
    });
    return { status: 'retrying', error: err.message, remedy: err.remedy, nextAttemptAt };
  }

  return finalizeFailure(scope, post, err.message, err.remedy, project, content, attempts);
}

async function finalizeFailure(
  scope: TenantScope,
  post: ScheduledPost,
  message: string,
  remedy: string | null,
  project?: Project,
  content?: ContentItem,
  attempts = post.attempts + 1,
): Promise<PublishOutcome> {
  await db().update(scope, 'scheduled_posts', post.id, {
    status: 'failed',
    attempts,
    last_error: message,
    next_attempt_at: null,
  });
  if (content) {
    await db().update(scope, 'content_items', content.id, { status: 'failed' });
  }
  if (project) {
    await recordError(scope, {
      projectId: project.id,
      scope: `publish:${post.platform}`,
      message,
      remedy,
      fatal: true,
    });
    await notify(scope, {
      user_id: project.user_id,
      project_id: project.id,
      severity: 'error',
      title: `A ${post.platform} post failed`,
      body: `${message}${remedy ? ` — ${remedy}` : ''}`,
      action_label: 'Open the calendar',
      action_href: '/app/calendar',
    });
  }
  log.error('publish failed permanently', { postId: post.id, message, attempts });
  return { status: 'failed', error: message, remedy };
}

/**
 * Re-queues everything that stalled on a platform. Called when a connection is
 * restored, which is what makes "resume automatically" true.
 */
export async function resumeAfterReconnect(
  scope: TenantScope,
  projectId: Uuid,
  platform: string,
): Promise<number> {
  const stalled = await db().find(scope, 'scheduled_posts', {
    where: { project_id: projectId, platform, status: 'failed' },
  });

  let resumed = 0;
  const now = Date.now();
  for (const post of stalled) {
    // Anything whose slot has passed goes out shortly, staggered.
    const at = new Date(Math.max(now + resumed * 120_000 + 60_000, Date.parse(post.scheduled_for)));
    await db().update(scope, 'scheduled_posts', post.id, {
      status: 'scheduled',
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      scheduled_for: at.toISOString(),
    });
    await db().update(scope, 'content_items', post.content_item_id, { status: 'scheduled' });
    resumed++;
  }

  if (resumed) log.info('resumed stalled posts after reconnect', { projectId, platform, resumed });
  return resumed;
}
