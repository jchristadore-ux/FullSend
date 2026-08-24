/**
 * THE SEND SCORE.
 *
 * A single 0–100 read on marketing momentum, built from five components that a
 * founder can actually move: are you making content, is it reaching people, are
 * they responding, are you showing up consistently, and is any of it converting.
 *
 * Every component reports what is driving it, so the score is a diagnosis
 * rather than a vanity number.
 */

import { nowIso } from '../ids';
import type { SendScore } from '../types';
import { engagementRate, totalEngagement, type PostPerformance } from './collect';

export interface SendScoreInput {
  performance: PostPerformance[];
  /** Posts sitting in the queue — content health is partly about runway. */
  queuedPosts: number;
  daysOfRunway: number;
  followersGained: number;
  followerBase: number;
  /** Days the project has been live, used to judge consistency fairly. */
  daysActive: number;
  connectedPlatforms: number;
}

const WEIGHTS = {
  content: 0.22,
  audience: 0.2,
  engagement: 0.26,
  consistency: 0.18,
  conversion: 0.14,
} as const;

export function computeSendScore(input: SendScoreInput): SendScore {
  const drivers: SendScore['drivers'] = [];

  const content = scoreContent(input, drivers);
  const audience = scoreAudience(input, drivers);
  const engagement = scoreEngagement(input, drivers);
  const consistency = scoreConsistency(input, drivers);
  const conversion = scoreConversion(input, drivers);

  const total = Math.round(
    content * WEIGHTS.content +
      audience * WEIGHTS.audience +
      engagement * WEIGHTS.engagement +
      consistency * WEIGHTS.consistency +
      conversion * WEIGHTS.conversion,
  );

  return {
    total: clamp(total),
    content: Math.round(content),
    audience: Math.round(audience),
    engagement: Math.round(engagement),
    consistency: Math.round(consistency),
    conversion: Math.round(conversion),
    drivers: drivers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 6),
    computed_at: nowIso(),
  };
}

/** Content: is the machine producing, and is there runway? */
function scoreContent(input: SendScoreInput, drivers: SendScore['drivers']): number {
  const published = input.performance.length;
  // 20 posts is a full score; the curve is generous early to reward starting.
  const volume = Math.min(100, Math.sqrt(published / 20) * 100);
  const runway = Math.min(100, (input.daysOfRunway / 14) * 100);
  const formatSpread = new Set(input.performance.map((p) => p.content.format)).size;
  const variety = Math.min(100, formatSpread * 33);

  const score = volume * 0.45 + runway * 0.35 + variety * 0.2;

  if (input.daysOfRunway < 5) {
    drivers.push({
      label: 'Queue running low',
      delta: -Math.round((1 - input.daysOfRunway / 14) * 20),
      detail: `${input.daysOfRunway} days of scheduled content left. FullSend tops this up on autopilot.`,
    });
  } else if (input.daysOfRunway >= 14) {
    drivers.push({
      label: 'Strong content runway',
      delta: 8,
      detail: `${input.queuedPosts} posts queued, ${input.daysOfRunway} days out.`,
    });
  }
  if (formatSpread <= 1 && published > 3) {
    drivers.push({
      label: 'Only one format in play',
      delta: -6,
      detail: 'Mixing formats gives the optimizer something to compare.',
    });
  }
  return clamp(score);
}

/** Audience: reach relative to the following, plus growth. */
function scoreAudience(input: SendScoreInput, drivers: SendScore['drivers']): number {
  const totalReach = input.performance.reduce((s, p) => s + (p.metrics.reach || p.metrics.views), 0);
  const avgReach = input.performance.length ? totalReach / input.performance.length : 0;

  // Reaching beyond the existing following is the signal that matters.
  const base = Math.max(1, input.followerBase);
  const reachRatio = avgReach / base;
  const reachScore = Math.min(100, Math.sqrt(reachRatio) * 70);

  const growthRate = input.followersGained / base;
  const growthScore = Math.min(100, growthRate * 1200);

  const platformScore = Math.min(100, input.connectedPlatforms * 50);

  if (reachRatio > 1.5 && input.performance.length >= 3) {
    drivers.push({
      label: 'Reaching past your following',
      delta: 12,
      detail: `Average reach is ${reachRatio.toFixed(1)}x your follower count.`,
    });
  }
  if (input.followersGained > 0) {
    drivers.push({
      label: 'Follower growth',
      delta: Math.min(10, Math.round(growthRate * 400)),
      detail: `+${input.followersGained} followers in this window.`,
    });
  }
  if (input.connectedPlatforms < 2) {
    drivers.push({
      label: 'One platform connected',
      delta: -8,
      detail: 'A second platform roughly doubles reachable audience.',
    });
  }

  return clamp(reachScore * 0.5 + growthScore * 0.3 + platformScore * 0.2);
}

/** Engagement: rate first, saves and shares weighted as intent signals. */
function scoreEngagement(input: SendScoreInput, drivers: SendScore['drivers']): number {
  if (input.performance.length === 0) return 0;

  const rates = input.performance.map((p) => engagementRate(p.metrics));
  const avgRate = rates.reduce((s, r) => s + r, 0) / rates.length;
  // 5% engagement is an excellent rate on either platform.
  const rateScore = Math.min(100, (avgRate / 0.05) * 100);

  const totals = input.performance.reduce(
    (acc, p) => {
      acc.saves += p.metrics.saves;
      acc.shares += p.metrics.shares;
      acc.comments += p.metrics.comments;
      acc.all += totalEngagement(p.metrics);
      return acc;
    },
    { saves: 0, shares: 0, comments: 0, all: 0 },
  );

  const intentRatio = totals.all ? (totals.saves + totals.shares) / totals.all : 0;
  const intentScore = Math.min(100, intentRatio * 320);

  if (avgRate > 0.04) {
    drivers.push({
      label: 'Engagement rate is strong',
      delta: 14,
      detail: `${(avgRate * 100).toFixed(1)}% average across ${input.performance.length} posts.`,
    });
  } else if (avgRate > 0 && avgRate < 0.015) {
    drivers.push({
      label: 'Engagement rate is soft',
      delta: -12,
      detail: `${(avgRate * 100).toFixed(1)}% average. Hooks are the usual fix.`,
    });
  }
  if (intentRatio > 0.25) {
    drivers.push({
      label: 'People are saving and sharing',
      delta: 10,
      detail: `${totals.saves} saves and ${totals.shares} shares — the strongest intent signals.`,
    });
  }

  return clamp(rateScore * 0.65 + intentScore * 0.35);
}

/** Consistency: gaps in the publishing rhythm are what kill accounts. */
function scoreConsistency(input: SendScoreInput, drivers: SendScore['drivers']): number {
  if (input.performance.length < 2) {
    return input.performance.length === 1 ? 35 : 0;
  }

  const dates = input.performance
    .map((p) => Date.parse(p.publishedPost.published_at))
    .sort((a, b) => a - b);

  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / 86_400_000);

  const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const variance = gaps.reduce((s, g) => s + (g - avgGap) ** 2, 0) / gaps.length;
  const stdDev = Math.sqrt(variance);

  // Ideal: publishing every ~2 days with little variation.
  const cadenceScore = Math.min(100, (2 / Math.max(0.5, avgGap)) * 100);
  const regularityScore = Math.max(0, 100 - stdDev * 22);

  const daysSinceLast = (Date.now() - dates[dates.length - 1]) / 86_400_000;
  const recencyPenalty = daysSinceLast > 3 ? Math.min(45, (daysSinceLast - 3) * 12) : 0;

  if (daysSinceLast > 4) {
    drivers.push({
      label: 'Gone quiet',
      delta: -Math.round(recencyPenalty / 2),
      detail: `${Math.round(daysSinceLast)} days since the last post.`,
    });
  }
  if (stdDev < 1.5 && gaps.length >= 3) {
    drivers.push({
      label: 'Publishing rhythm is steady',
      delta: 9,
      detail: `Posting roughly every ${avgGap.toFixed(1)} days.`,
    });
  }

  return clamp(cadenceScore * 0.45 + regularityScore * 0.55 - recencyPenalty);
}

/** Conversion: profile visits and clicks are what marketing is actually for. */
function scoreConversion(input: SendScoreInput, drivers: SendScore['drivers']): number {
  if (input.performance.length === 0) return 0;

  const totals = input.performance.reduce(
    (acc, p) => {
      acc.visits += p.metrics.profile_visits;
      acc.clicks += p.metrics.clicks;
      acc.conversions += p.metrics.conversions;
      acc.reach += p.metrics.reach || p.metrics.views;
      return acc;
    },
    { visits: 0, clicks: 0, conversions: 0, reach: 0 },
  );

  if (totals.reach === 0) return 0;

  const visitRate = totals.visits / totals.reach;
  const clickRate = totals.clicks / Math.max(1, totals.visits);

  // 1.5% of reach visiting the profile is a good result.
  const visitScore = Math.min(100, (visitRate / 0.015) * 100);
  const clickScore = Math.min(100, (clickRate / 0.1) * 100);
  const conversionScore = totals.conversions > 0 ? 100 : 0;

  if (totals.visits === 0 && totals.reach > 500) {
    drivers.push({
      label: 'Reach is not turning into profile visits',
      delta: -14,
      detail: 'The CTA is the usual culprit. FullSend will test stronger ones.',
    });
  }
  if (totals.clicks > 0) {
    drivers.push({
      label: 'Link clicks are landing',
      delta: 11,
      detail: `${totals.clicks} clicks from ${totals.visits} profile visits.`,
    });
  }

  return clamp(visitScore * 0.5 + clickScore * 0.3 + conversionScore * 0.2);
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Plain-language read on a score, shown next to the number. */
export function scoreVerdict(score: number): { label: string; tone: 'good' | 'ok' | 'poor' } {
  if (score >= 75) return { label: 'Sending', tone: 'good' };
  if (score >= 55) return { label: 'Building momentum', tone: 'good' };
  if (score >= 35) return { label: 'Warming up', tone: 'ok' };
  if (score > 0) return { label: 'Needs volume', tone: 'poor' };
  return { label: 'Not started', tone: 'poor' };
}
