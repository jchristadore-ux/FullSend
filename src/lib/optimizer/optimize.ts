/**
 * The optimizer.
 *
 * Reads what actually happened, works out why, and changes what comes next.
 * It forms an opinion and — under Full Send — acts on it without asking. The
 * founder sees what it decided and can reverse it, rather than being asked to
 * make the decision in the first place.
 */
import 'server-only';
import { generateObject } from '../ai/client';
import { type TenantScope } from '../db';
import { db, getStrategy, listRecommendations, notify } from '../db/repo';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import { recommendationsSchema } from '../schemas';
import { normaliseMix } from '../strategy/build';
import { shiftMix } from '../content/mix';
import { engagementRate, postPerformance, type PostPerformance } from '../analytics/collect';
import type {
  ContentFormat,
  Experiment,
  PillarType,
  Platform,
  PostMetrics,
  Project,
  Recommendation,
  RecommendationAction,
  Uuid,
} from '../types';

const log = logger('optimizer');

/** Below this, a difference is noise. The optimizer says so rather than acting. */
const MIN_SAMPLES = 3;

const OPTIMIZER_SYSTEM = `You are FullSend's performance analyst.

You are given real published-post performance for one product. Work out what is
working, why, and what should change next week.

You have an opinion and you state it. Do not ask the user what they want.
Do not hedge. Write recommendations the way a good growth lead talks:

  "Reels are outperforming carousels 2.4x. I'm increasing Reels from 3 to 5 per week."

Rules:
- Never recommend a change from fewer than 3 samples per side. If the data is
  thin, say so plainly and recommend volume instead.
- Every recommendation must carry the numbers it is based on.
- "confidence" is a number between 0 and 1 — 0.4, never "medium" and never
  "40%" — and must reflect sample size honestly.
- Prefer one or two decisive changes over five timid ones.

Return JSON only.`;

export interface Dimension<T extends string> {
  key: T;
  samples: number;
  mean_engagement: number;
  mean_reach: number;
  mean_rate: number;
}

/** Groups performance by a dimension and computes means. */
export function groupBy<T extends string>(
  performance: PostPerformance[],
  keyFn: (p: PostPerformance) => T | null,
): Dimension<T>[] {
  const buckets = new Map<T, PostPerformance[]>();
  for (const p of performance) {
    const key = keyFn(p);
    if (key === null) continue;
    const list = buckets.get(key) ?? [];
    list.push(p);
    buckets.set(key, list);
  }

  return [...buckets].map(([key, list]) => ({
    key,
    samples: list.length,
    mean_engagement: list.reduce((s, p) => s + p.engagement, 0) / list.length,
    mean_reach:
      list.reduce((s, p) => s + (p.metrics.reach || p.metrics.views), 0) / list.length,
    mean_rate: list.reduce((s, p) => s + engagementRate(p.metrics), 0) / list.length,
  }));
}

export interface OptimizeResult {
  recommendations: Recommendation[];
  applied: Recommendation[];
  experiments: Experiment[];
  postsAnalyzed: number;
  costUsd: number;
}

export async function optimize(
  scope: TenantScope,
  project: Project,
  opts: { since?: string; autoApply?: boolean } = {},
): Promise<OptimizeResult> {
  const since =
    opts.since ?? new Date(Date.now() - 28 * 86_400_000).toISOString();
  const performance = await postPerformance(scope, project.id, since);

  const pillars = await db().find(scope, 'content_pillars', {
    where: { project_id: project.id },
  });
  const pillarType = (p: PostPerformance): PillarType | null =>
    pillars.find((pl) => pl.id === p.content.pillar_id)?.type ?? null;

  const byFormat = groupBy<ContentFormat>(performance, (p) => p.content.format);
  const byPillar = groupBy<PillarType>(performance, pillarType);
  const byPlatform = groupBy<Platform>(performance, (p) => p.content.platform);
  const byHour = groupBy<string>(performance, (p) =>
    String(new Date(p.publishedPost.published_at).getUTCHours()),
  );

  const experiments = await recordExperiments(scope, project.id, byFormat, byPillar);

  const { data, costUsd } = await generateObject({
    task: 'optimizer.recommendations',
    system: OPTIMIZER_SYSTEM,
    brief: `What should ${project.name} change next week?`,
    context: {
      posts_analyzed: performance.length,
      window_days: 28,
      format_performance: byFormat.map((d) => ({
        format: d.key,
        platform: dominantPlatform(performance, (p) => p.content.format === d.key),
        samples: d.samples,
        mean_engagement: round(d.mean_engagement),
        mean_reach: round(d.mean_reach),
        mean_rate: round(d.mean_rate, 4),
      })),
      pillar_performance: byPillar.map((d) => ({
        pillar: d.key,
        samples: d.samples,
        mean_engagement: round(d.mean_engagement),
        mean_rate: round(d.mean_rate, 4),
      })),
      platform_performance: byPlatform.map((d) => ({
        platform: d.key,
        samples: d.samples,
        mean_engagement: round(d.mean_engagement),
        mean_reach: round(d.mean_reach),
      })),
      hour_performance: byHour
        .filter((d) => d.samples >= 2)
        .map((d) => ({ hour: Number(d.key), samples: d.samples, mean_reach: round(d.mean_reach) })),
      top_posts: [...performance]
        .sort((a, b) => b.engagement - a.engagement)
        .slice(0, 5)
        .map((p) => ({
          hook: p.content.hook,
          format: p.content.format,
          platform: p.content.platform,
          engagement: p.engagement,
          reach: p.metrics.reach || p.metrics.views,
        })),
      weakest_posts: [...performance]
        .sort((a, b) => a.engagement - b.engagement)
        .slice(0, 3)
        .map((p) => ({ hook: p.content.hook, format: p.content.format, engagement: p.engagement })),
      minimum_samples_required: MIN_SAMPLES,
    },
    schema: recommendationsSchema,
    noCache: true,
    attribution: { scope, projectId: project.id, userId: project.user_id },
  });

  const saved: Recommendation[] = [];
  for (const rec of data.recommendations) {
    saved.push(
      await db().insert(scope, 'recommendations', {
        id: newId(),
        project_id: project.id,
        statement: rec.statement,
        rationale: rec.rationale,
        evidence: rec.evidence,
        action: rec.action as RecommendationAction,
        confidence: rec.confidence,
        status: 'proposed',
        applied_at: null,
        created_at: nowIso(),
      }),
    );
  }

  // Full Send means the machine acts. It still refuses low-confidence changes.
  const autoApply = opts.autoApply ?? project.autopilot_mode === 'full_send';
  const applied: Recommendation[] = [];
  if (autoApply) {
    for (const rec of saved) {
      if (rec.confidence < 0.55) continue;
      const ok = await applyRecommendation(scope, project, rec, true);
      if (ok) applied.push(rec);
    }
  }

  if (applied.length) {
    await notify(scope, {
      user_id: project.user_id,
      project_id: project.id,
      severity: 'info',
      title: 'FullSend adjusted your strategy',
      body: applied.map((r) => r.statement).join(' '),
      action_label: 'See what changed',
      action_href: '/app/analytics',
    });
  }

  log.info('optimization complete', {
    project: project.id,
    analyzed: performance.length,
    recommendations: saved.length,
    applied: applied.length,
  });

  return {
    recommendations: saved,
    applied,
    experiments,
    postsAnalyzed: performance.length,
    costUsd,
  };
}

/**
 * Applies a recommendation for real: mutates the strategy, the cadence or the
 * queue. This is what makes the optimizer more than a dashboard widget.
 */
export async function applyRecommendation(
  scope: TenantScope,
  project: Project,
  rec: Recommendation,
  auto = false,
): Promise<boolean> {
  const strategy = await getStrategy(scope, project.id);
  if (!strategy) return false;

  // Bound once so TypeScript keeps the discriminated-union narrowing below.
  const action = rec.action;

  try {
    switch (action.type) {
      case 'shift_mix': {
        const next = normaliseMix(
          shiftMix(strategy.content_mix, action.from, action.to, action.points),
        );
        await db().update(scope, 'marketing_strategies', strategy.id, { content_mix: next });
        await realignPillarWeights(scope, project.id, next);
        break;
      }
      case 'increase_format': {
        const cadence = { ...strategy.posting_cadence };
        const key = action.platform === 'instagram' ? 'instagram_per_week' : 'tiktok_per_week';
        cadence[key] = Math.min(14, (cadence[key] ?? 4) + action.per_week);
        await db().update(scope, 'marketing_strategies', strategy.id, {
          posting_cadence: cadence,
        });
        break;
      }
      case 'shift_time': {
        const cadence = { ...strategy.posting_cadence };
        const times = [...(cadence.best_times ?? [])];
        const idx = times.findIndex((t) => t.platform === action.platform);
        const entry = { day: action.day, hour: action.hour, platform: action.platform };
        if (idx >= 0) times[idx] = entry;
        else times.push(entry);
        cadence.best_times = times;
        await db().update(scope, 'marketing_strategies', strategy.id, {
          posting_cadence: cadence,
        });
        break;
      }
      case 'increase_platform_weight': {
        const platforms = strategy.platform_strategy.map((p) =>
          p.platform === action.platform
            ? { ...p, weight: Math.min(100, p.weight + action.points) }
            : p,
        );
        await db().update(scope, 'marketing_strategies', strategy.id, {
          platform_strategy: platforms,
        });
        break;
      }
      case 'favor_hook_style': {
        // Recorded on the brand profile so every future generation sees it.
        const brand = await db().findOne(scope, 'brand_profiles', {
          where: { project_id: project.id },
        });
        if (brand) {
          const pillars = [...brand.messaging_pillars];
          const note = `Hook style that works: ${action.style}`;
          if (!pillars.includes(note)) pillars.push(note);
          await db().update(scope, 'brand_profiles', brand.id, {
            messaging_pillars: pillars.slice(-8),
            updated_at: nowIso(),
          });
        }
        break;
      }
      case 'generate_content':
        // Handled by the autopilot, which owns generation scheduling.
        break;
    }

    await db().update(scope, 'recommendations', rec.id, {
      status: auto ? 'auto_applied' : 'applied',
      applied_at: nowIso(),
    });
    return true;
  } catch (e) {
    log.warn('could not apply recommendation', { recId: rec.id, error: String(e) });
    return false;
  }
}

export async function dismissRecommendation(
  scope: TenantScope,
  recId: Uuid,
): Promise<Recommendation> {
  return db().update(scope, 'recommendations', recId, { status: 'dismissed' });
}

/** Pillar weights follow the mix, so the calendar reflects the change. */
async function realignPillarWeights(
  scope: TenantScope,
  projectId: Uuid,
  mix: Record<PillarType, number>,
): Promise<void> {
  const pillars = await db().find(scope, 'content_pillars', { where: { project_id: projectId } });
  const counts = new Map<PillarType, number>();
  for (const p of pillars) counts.set(p.type, (counts.get(p.type) ?? 0) + 1);
  for (const p of pillars) {
    await db().update(scope, 'content_pillars', p.id, {
      weight: Math.round(mix[p.type] / (counts.get(p.type) || 1)),
    });
  }
}

/**
 * Records what each comparison actually showed, so the founder can see the
 * evidence behind a change and the machine keeps a memory of past tests.
 */
async function recordExperiments(
  scope: TenantScope,
  projectId: Uuid,
  byFormat: Dimension<ContentFormat>[],
  byPillar: Dimension<PillarType>[],
): Promise<Experiment[]> {
  const out: Experiment[] = [];

  const pairs: {
    dimension: Experiment['dimension'];
    a: Dimension<string>;
    b: Dimension<string>;
  }[] = [];

  const rankedFormats = [...byFormat].sort((x, y) => y.mean_engagement - x.mean_engagement);
  if (rankedFormats.length >= 2) {
    pairs.push({
      dimension: 'format',
      a: rankedFormats[0],
      b: rankedFormats[rankedFormats.length - 1],
    });
  }
  const rankedPillars = [...byPillar].sort((x, y) => y.mean_engagement - x.mean_engagement);
  if (rankedPillars.length >= 2) {
    pairs.push({
      dimension: 'pillar',
      a: rankedPillars[0],
      b: rankedPillars[rankedPillars.length - 1],
    });
  }

  for (const { dimension, a, b } of pairs) {
    const confident = a.samples >= MIN_SAMPLES && b.samples >= MIN_SAMPLES;
    const lift = b.mean_engagement > 0 ? a.mean_engagement / b.mean_engagement : 0;
    out.push(
      await db().insert(scope, 'experiments', {
        id: newId(),
        project_id: projectId,
        hypothesis: `${a.key} outperforms ${b.key} on engagement`,
        dimension,
        variant_a: String(a.key),
        variant_b: String(b.key),
        metric: 'likes' as keyof PostMetrics,
        a_samples: a.samples,
        b_samples: b.samples,
        a_mean: round(a.mean_engagement),
        b_mean: round(b.mean_engagement),
        lift: round(lift, 2),
        confident,
        status: confident ? 'concluded' : 'inconclusive',
        conclusion: confident
          ? `${a.key} averaged ${round(a.mean_engagement)} engagements vs ${round(b.mean_engagement)} for ${b.key} (${lift.toFixed(1)}x).`
          : `Not enough data — ${a.samples} vs ${b.samples} posts. Need ${MIN_SAMPLES} each.`,
        created_at: nowIso(),
        concluded_at: confident ? nowIso() : null,
      }),
    );
  }
  return out;
}

function dominantPlatform(
  performance: PostPerformance[],
  filter: (p: PostPerformance) => boolean,
): Platform {
  const counts = new Map<Platform, number>();
  for (const p of performance.filter(filter)) {
    counts.set(p.content.platform, (counts.get(p.content.platform) ?? 0) + 1);
  }
  let best: Platform = 'instagram';
  let bestCount = -1;
  for (const [platform, count] of counts) {
    if (count > bestCount) {
      best = platform;
      bestCount = count;
    }
  }
  return best;
}

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** The single line shown as "FULLSEND'S NEXT MOVE" on the dashboard. */
export async function nextMove(
  scope: TenantScope,
  projectId: Uuid,
): Promise<Recommendation | null> {
  const recs = await listRecommendations(scope, projectId);
  return (
    recs.find((r) => r.status === 'proposed') ??
    recs.find((r) => r.status === 'auto_applied') ??
    null
  );
}
