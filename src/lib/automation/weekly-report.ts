/**
 * THE WEEKLY SEND REPORT.
 *
 * One honest read per week: what went out, what it did, what won, what FullSend
 * learned, and what it is changing next week.
 */
import 'server-only';
import { generateObject } from '../ai/client';
import { systemScope, type TenantScope } from '../db';
import { db, latestWeeklyReport, notify } from '../db/repo';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import { weeklyInsightSchema } from '../schemas';
import { computeSendScore } from '../analytics/send-score';
import { postPerformance, sumMetrics, totalEngagement } from '../analytics/collect';
import { queueDepth } from '../scheduler/schedule';
import { groupBy } from '../optimizer/optimize';
import type {
  ContentFormat,
  Platform,
  Project,
  WeeklyReport,
} from '../types';

const log = logger('weekly-report');

const REPORT_SYSTEM = `You are FullSend, writing the weekly report to the founder.

You have this week's real numbers. Say what actually happened and what you are
changing. Two fields only: the biggest learning, and next week's strategy.

Be direct and specific. Cite the numbers. If the week was thin, say so — a
founder can act on "not enough volume to read a pattern" but not on flattery.

Return JSON only.`;

export function weekBounds(reference = new Date()): { start: Date; end: Date } {
  const end = new Date(reference);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 7 * 86_400_000);
  return { start, end };
}

export async function generateWeeklyReport(
  projectId: string,
  reference = new Date(),
): Promise<WeeklyReport> {
  const scope = systemScope('weekly report');
  const project = await db().get(scope, 'projects', projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const { start, end } = weekBounds(reference);
  const performance = await postPerformance(scope, projectId, start.toISOString());
  const inWeek = performance.filter(
    (p) => Date.parse(p.publishedPost.published_at) < end.getTime(),
  );

  const totals = sumMetrics(inWeek.map((p) => p.metrics));
  const byFormat = groupBy<ContentFormat>(inWeek, (p) => p.content.format);
  const byPlatform = groupBy<Platform>(inWeek, (p) => p.content.platform);

  const best = [...inWeek].sort((a, b) => b.engagement - a.engagement)[0] ?? null;
  const bestFormat =
    [...byFormat].sort((a, b) => b.mean_engagement - a.mean_engagement)[0]?.key ?? null;
  const bestPlatform =
    [...byPlatform].sort((a, b) => b.mean_engagement - a.mean_engagement)[0]?.key ?? null;

  const previous = await latestWeeklyReport(scope, projectId);
  const accounts = await db().find(scope, 'social_accounts', {
    where: { project_id: projectId, status: 'connected' },
  });
  const followerBase = accounts.reduce((s, a) => s + a.followers, 0);
  const runway = await queueDepth(scope, projectId);

  const sendScore = computeSendScore({
    performance,
    queuedPosts: runway.queued,
    daysOfRunway: runway.daysOfRunway,
    followersGained: Math.max(0, totals.follows - (previous?.followers_gained ?? 0)),
    followerBase,
    daysActive: Math.max(
      1,
      Math.ceil((Date.now() - Date.parse(project.created_at)) / 86_400_000),
    ),
    connectedPlatforms: accounts.length,
  });

  const { data } = await generateObject({
    task: 'report.weekly',
    system: REPORT_SYSTEM,
    brief: `Write this week's report for ${project.name}.`,
    context: {
      posts: inWeek.length,
      reach: totals.reach,
      views: totals.views,
      engagement: totalEngagement(totals),
      clicks: totals.clicks,
      conversions: totals.conversions,
      previous_reach: previous?.reach ?? 0,
      previous_posts: previous?.total_posts ?? 0,
      best_hook: best?.content.hook ?? null,
      best_format: bestFormat,
      best_platform: bestPlatform,
      format_breakdown: byFormat.map((f) => ({
        format: f.key,
        samples: f.samples,
        mean_engagement: Math.round(f.mean_engagement),
      })),
      send_score: sendScore.total,
      score_drivers: sendScore.drivers,
      days_of_runway: runway.daysOfRunway,
    },
    schema: weeklyInsightSchema,
    noCache: true,
    attribution: { scope, projectId, userId: project.user_id },
  });

  const existing = await db().findOne(scope, 'weekly_reports', {
    where: { project_id: projectId, week_start: start.toISOString().slice(0, 10) },
  });

  const payload = {
    total_posts: inWeek.length,
    reach: totals.reach,
    engagement: totalEngagement(totals),
    followers_gained: Math.max(0, totals.follows - (previous?.followers_gained ?? 0)),
    clicks: totals.clicks,
    conversions: totals.conversions,
    best_post_id: best?.publishedPost.id ?? null,
    best_hook: best?.content.hook ?? null,
    best_format: bestFormat,
    best_platform: bestPlatform,
    biggest_learning: data.biggest_learning,
    next_week_strategy: data.next_week_strategy,
    send_score: sendScore,
  };

  const report = existing
    ? await db().update(scope, 'weekly_reports', existing.id, payload)
    : await db().insert(scope, 'weekly_reports', {
        id: newId(),
        project_id: projectId,
        week_start: start.toISOString().slice(0, 10),
        week_end: end.toISOString().slice(0, 10),
        created_at: nowIso(),
        ...payload,
      });

  await notify(scope, {
    user_id: project.user_id,
    project_id: projectId,
    severity: 'info',
    title: 'Your Weekly Send Report is ready',
    body:
      `${inWeek.length} posts, ${formatNumber(totals.reach)} reach, Send Score ${sendScore.total}. ` +
      data.biggest_learning,
    action_label: 'Read the report',
    action_href: '/app/analytics',
  });

  log.info('weekly report generated', {
    projectId,
    posts: inWeek.length,
    sendScore: sendScore.total,
  });
  return report;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Current Send Score for a project, computed live for the dashboard. */
export async function currentSendScore(scope: TenantScope, project: Project) {
  const since = new Date(Date.now() - 28 * 86_400_000).toISOString();
  const performance = await postPerformance(scope, project.id, since);
  const accounts = await db().find(scope, 'social_accounts', {
    where: { project_id: project.id, status: 'connected' },
  });
  const runway = await queueDepth(scope, project.id);
  const totals = sumMetrics(performance.map((p) => p.metrics));

  return computeSendScore({
    performance,
    queuedPosts: runway.queued,
    daysOfRunway: runway.daysOfRunway,
    followersGained: totals.follows,
    followerBase: accounts.reduce((s, a) => s + a.followers, 0),
    daysActive: Math.max(
      1,
      Math.ceil((Date.now() - Date.parse(project.created_at)) / 86_400_000),
    ),
    connectedPlatforms: accounts.length,
  });
}
