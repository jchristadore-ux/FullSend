/**
 * Dashboard read model.
 *
 * One query pass that assembles everything THE SEND CENTER shows, so the page
 * is a single await and the mobile view can reuse the same shape.
 */
import 'server-only';
import { type TenantScope } from './db';
import {
  db,
  getAnalysis,
  getStrategy,
  latestWeeklyReport,
  listPublished,
  listSocialAccounts,
} from './db/repo';
import { nextSend, queueDepth, type CalendarEntry } from './scheduler/schedule';
import { postPerformance, summarise, type PostPerformance } from './analytics/collect';
import { currentSendScore } from './automation/weekly-report';
import { nextMove } from './optimizer/optimize';
import { svgDataUri } from './creative/render';
import { aiSpend } from './ai/client';
import type {
  AutomationError,
  Project,
  Recommendation,
  SendScore,
  SocialAccount,
  WeeklyReport,
} from './types';

export interface SendCenterData {
  project: Project;
  autopilotOn: boolean;
  accounts: SocialAccount[];
  /** Connection problems that have paused publishing. Shown as a banner. */
  attention: { platform: string; message: string; remedy: string | null }[];
  metrics: {
    postsScheduled: number;
    postsPublished: number;
    reach: number;
    engagement: number;
    clicks: number;
    conversions: number;
  };
  nextSend: (CalendarEntry & { preview: string | null }) | null;
  recentSends: {
    id: string;
    hook: string;
    platform: string;
    format: string;
    permalink: string | null;
    publishedAt: string;
    engagement: number;
    reach: number;
    preview: string | null;
  }[];
  whatsWorking: PostPerformance[];
  nextMove: Recommendation | null;
  sendScore: SendScore;
  runway: { queued: number; daysOfRunway: number };
  weeklyReport: WeeklyReport | null;
  hasStrategy: boolean;
  strategyApproved: boolean;
  hasAnalysis: boolean;
  aiCostUsd: number;
}

export async function loadSendCenter(
  scope: TenantScope,
  project: Project,
): Promise<SendCenterData> {
  const since = new Date(Date.now() - 28 * 86_400_000).toISOString();

  const [
    accounts,
    summary,
    upcoming,
    performance,
    recommendation,
    score,
    runway,
    report,
    strategy,
    analysis,
    errors,
    spend,
  ] = await Promise.all([
    listSocialAccounts(scope, project.id),
    summarise(scope, project.id, since),
    nextSend(scope, project.id),
    postPerformance(scope, project.id, since),
    nextMove(scope, project.id),
    currentSendScore(scope, project),
    queueDepth(scope, project.id),
    latestWeeklyReport(scope, project.id),
    getStrategy(scope, project.id),
    getAnalysis(scope, project.id),
    db().find(scope, 'automation_errors', {
      where: { project_id: project.id, resolved: false },
      orderBy: 'created_at',
      direction: 'desc',
      limit: 5,
    }),
    aiSpend(scope, { projectId: project.id }),
  ]);

  const published = await listPublished(scope, project.id, 6);
  const byPostId = new Map(performance.map((p) => [p.publishedPost.id, p]));

  const recentSends = await Promise.all(
    published.map(async (post) => {
      const perf = byPostId.get(post.id);
      const content =
        perf?.content ?? (await db().get(scope, 'content_items', post.content_item_id));
      return {
        id: post.id,
        hook: content?.hook ?? '—',
        platform: post.platform,
        format: content?.format ?? 'static',
        permalink: post.permalink,
        publishedAt: post.published_at,
        engagement: perf?.engagement ?? 0,
        reach: perf?.metrics.reach ?? 0,
        preview: content ? await previewFor(scope, project.id, content.id) : null,
      };
    }),
  );

  const attention: { platform: string; message: string; remedy: string | null }[] = accounts
    .filter((a) => a.status === 'expired' || a.status === 'revoked' || a.status === 'error')
    .map((a) => ({
      platform: a.platform as string,
      message: a.status_detail ?? `Your ${a.platform} connection needs attention`,
      remedy: `Reconnect ${a.platform} and FullSend resumes publishing automatically.`,
    }));

  for (const err of errors as AutomationError[]) {
    if (err.fatal && !attention.some((x) => err.scope.includes(x.platform))) {
      attention.push({ platform: err.scope, message: err.message, remedy: err.remedy });
    }
  }

  return {
    project,
    autopilotOn: project.autopilot_mode !== 'manual' && project.status !== 'paused',
    accounts,
    attention,
    metrics: {
      postsScheduled: summary.postsScheduled,
      postsPublished: summary.postsPublished,
      reach: summary.reach,
      engagement: summary.engagement,
      clicks: summary.clicks,
      conversions: summary.conversions,
    },
    nextSend: upcoming
      ? { ...upcoming, preview: await previewFor(scope, project.id, upcoming.content.id) }
      : null,
    recentSends,
    whatsWorking: [...performance].sort((a, b) => b.engagement - a.engagement).slice(0, 3),
    nextMove: recommendation,
    sendScore: score,
    runway: { queued: runway.queued, daysOfRunway: runway.daysOfRunway },
    weeklyReport: report,
    hasStrategy: Boolean(strategy),
    strategyApproved: Boolean(strategy?.approved),
    hasAnalysis: Boolean(analysis),
    aiCostUsd: spend.total,
  };
}

async function previewFor(
  scope: TenantScope,
  projectId: string,
  contentItemId: string,
): Promise<string | null> {
  const asset = await db().findOne(scope, 'creative_assets', {
    where: { project_id: projectId, content_item_id: contentItemId },
  });
  if (!asset) return null;
  return asset.url ?? (asset.svg ? svgDataUri(asset.svg) : null);
}

export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function relativeTime(iso: string): string {
  const diff = Date.parse(iso) - Date.now();
  const future = diff > 0;
  const mins = Math.abs(Math.round(diff / 60_000));

  if (mins < 1) return 'just now';
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return future ? 'tomorrow' : 'yesterday';
  if (days < 7) return future ? `in ${days} days` : `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatSendTime(iso: string, timezone: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: safeZone(timezone),
  });
  const day = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: safeZone(timezone),
  });
  return `${day} — ${time}`;
}

function safeZone(tz: string): string | undefined {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}
