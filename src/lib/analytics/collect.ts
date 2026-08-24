/**
 * Analytics collection.
 *
 * Pulls real numbers from each platform's insights API for every published post
 * and for the account itself. Snapshots accumulate over time so growth, not
 * just the latest value, is readable. Metrics FullSend cannot get from a
 * platform stay zero rather than being estimated into existence.
 */
import 'server-only';
import { type TenantScope } from '../db';
import { db, listAnalytics, listPublished } from '../db/repo';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import { getUsableConnection } from '../social/connections';
import { getAdapter } from '../social/registry';
import { emptyMetrics } from '../social/types';
import type {
  AnalyticsSnapshot,
  ContentItem,
  Platform,
  PostMetrics,
  PublishedPost,
  Uuid,
} from '../types';

const log = logger('analytics');

export interface CollectionResult {
  postsCollected: number;
  accountsCollected: number;
  errors: { platform: Platform; message: string }[];
}

/**
 * Only posts younger than this are re-collected — older ones have settled and
 * re-polling them wastes API quota.
 */
const ACTIVE_WINDOW_DAYS = 30;

export async function collectAnalytics(
  scope: TenantScope,
  projectId: Uuid,
): Promise<CollectionResult> {
  const result: CollectionResult = { postsCollected: 0, accountsCollected: 0, errors: [] };
  const published = await listPublished(scope, projectId, 200);
  const cutoff = Date.now() - ACTIVE_WINDOW_DAYS * 86_400_000;
  const active = published.filter((p) => Date.parse(p.published_at) >= cutoff);

  const byPlatform = new Map<Platform, PublishedPost[]>();
  for (const post of active) {
    const list = byPlatform.get(post.platform) ?? [];
    list.push(post);
    byPlatform.set(post.platform, list);
  }

  for (const [platform, posts] of byPlatform) {
    try {
      const connection = await getUsableConnection(scope, projectId, platform);
      const adapter = getAdapter(platform);

      for (const post of posts) {
        try {
          const partial = await adapter.getPostMetrics(
            connection.tokens,
            connection.info,
            post.external_id,
          );
          if (Object.keys(partial).length === 0) continue;

          const metrics = { ...emptyMetrics(), ...partial };
          await db().insert(scope, 'analytics', {
            id: newId(),
            project_id: projectId,
            published_post_id: post.id,
            social_account_id: connection.account.id,
            platform,
            scope: 'post',
            metrics,
            from_platform_api: true,
            collected_at: nowIso(),
          });
          result.postsCollected++;
        } catch (e) {
          log.warn('post metrics failed', { postId: post.id, error: String(e) });
        }
      }

      const accountPartial = await adapter.getAccountMetrics(connection.tokens, connection.info);
      if (Object.keys(accountPartial).length) {
        await db().insert(scope, 'analytics', {
          id: newId(),
          project_id: projectId,
          published_post_id: null,
          social_account_id: connection.account.id,
          platform,
          scope: 'account',
          metrics: { ...emptyMetrics(), ...accountPartial },
          from_platform_api: true,
          collected_at: nowIso(),
        });
        result.accountsCollected++;
        if (accountPartial.follows) {
          await db().update(scope, 'social_accounts', connection.account.id, {
            followers: accountPartial.follows,
          });
        }
      }
    } catch (e) {
      result.errors.push({ platform, message: e instanceof Error ? e.message : String(e) });
    }
  }

  log.info('analytics collected', {
    projectId,
    posts: result.postsCollected,
    accounts: result.accountsCollected,
    errors: result.errors.length,
  });
  return result;
}

/** The latest snapshot per post — earlier snapshots are history, not truth. */
export async function latestMetricsByPost(
  scope: TenantScope,
  projectId: Uuid,
  since?: string,
): Promise<Map<Uuid, PostMetrics>> {
  const snapshots = await listAnalytics(scope, projectId, { since, scopeKind: 'post' });
  const latest = new Map<Uuid, { at: number; metrics: PostMetrics }>();

  for (const snap of snapshots) {
    if (!snap.published_post_id) continue;
    const at = Date.parse(snap.collected_at);
    const current = latest.get(snap.published_post_id);
    if (!current || at > current.at) {
      latest.set(snap.published_post_id, { at, metrics: snap.metrics });
    }
  }
  return new Map([...latest].map(([k, v]) => [k, v.metrics]));
}

export function totalEngagement(m: PostMetrics): number {
  return m.likes + m.comments + m.shares + m.saves;
}

export function engagementRate(m: PostMetrics): number {
  const denominator = m.reach || m.views || m.impressions;
  if (!denominator) return 0;
  return totalEngagement(m) / denominator;
}

export function sumMetrics(list: PostMetrics[]): PostMetrics {
  const out = emptyMetrics();
  for (const m of list) {
    out.views += m.views;
    out.reach += m.reach;
    out.impressions += m.impressions;
    out.watch_time_seconds += m.watch_time_seconds;
    out.likes += m.likes;
    out.comments += m.comments;
    out.shares += m.shares;
    out.saves += m.saves;
    out.profile_visits += m.profile_visits;
    out.clicks += m.clicks;
    out.conversions += m.conversions;
    out.follows += m.follows;
  }
  out.completion_rate = list.length
    ? list.reduce((s, m) => s + m.completion_rate, 0) / list.length
    : 0;
  return out;
}

export interface PostPerformance {
  publishedPost: PublishedPost;
  content: ContentItem;
  metrics: PostMetrics;
  engagement: number;
  engagementRate: number;
}

/** Published posts joined to their latest metrics. The optimizer's input. */
export async function postPerformance(
  scope: TenantScope,
  projectId: Uuid,
  since?: string,
): Promise<PostPerformance[]> {
  const published = await listPublished(scope, projectId, 200);
  const inWindow = since
    ? published.filter((p) => Date.parse(p.published_at) >= Date.parse(since))
    : published;
  const metricsByPost = await latestMetricsByPost(scope, projectId);

  const out: PostPerformance[] = [];
  for (const post of inWindow) {
    const content = await db().get(scope, 'content_items', post.content_item_id);
    if (!content) continue;
    const metrics = metricsByPost.get(post.id) ?? emptyMetrics();
    out.push({
      publishedPost: post,
      content,
      metrics,
      engagement: totalEngagement(metrics),
      engagementRate: engagementRate(metrics),
    });
  }
  return out;
}

export interface SummaryTotals {
  postsPublished: number;
  postsScheduled: number;
  reach: number;
  views: number;
  engagement: number;
  clicks: number;
  conversions: number;
  followersGained: number;
  /** True when at least one metric came from a platform API. */
  hasRealData: boolean;
}

export async function summarise(
  scope: TenantScope,
  projectId: Uuid,
  since?: string,
): Promise<SummaryTotals> {
  const performance = await postPerformance(scope, projectId, since);
  const totals = sumMetrics(performance.map((p) => p.metrics));

  const scheduled = await db().count(scope, 'scheduled_posts', {
    where: { project_id: projectId, status: 'scheduled' },
  });

  const accountSnaps = await listAnalytics(scope, projectId, { since, scopeKind: 'account' });
  const followersGained = followerDelta(accountSnaps);

  return {
    postsPublished: performance.length,
    postsScheduled: scheduled,
    reach: totals.reach,
    views: totals.views,
    engagement: totalEngagement(totals),
    clicks: totals.clicks,
    conversions: totals.conversions,
    followersGained,
    hasRealData: performance.some((p) => totalEngagement(p.metrics) > 0 || p.metrics.reach > 0),
  };
}

/** Follower growth is a difference between snapshots, not a sum. */
function followerDelta(snapshots: AnalyticsSnapshot[]): number {
  const byPlatform = new Map<Platform, AnalyticsSnapshot[]>();
  for (const s of snapshots) {
    const list = byPlatform.get(s.platform) ?? [];
    list.push(s);
    byPlatform.set(s.platform, list);
  }

  let delta = 0;
  for (const list of byPlatform.values()) {
    const sorted = [...list].sort(
      (a, b) => Date.parse(a.collected_at) - Date.parse(b.collected_at),
    );
    const first = sorted[0]?.metrics.follows ?? 0;
    const last = sorted[sorted.length - 1]?.metrics.follows ?? 0;
    if (last > first) delta += last - first;
  }
  return delta;
}
