/**
 * Trend engine.
 *
 * Neither Meta nor TikTok exposes a general trending-topics API to a standard
 * content-posting client, so FullSend does not pretend to read the zeitgeist.
 * What it does instead is honest and still useful:
 *
 *   1. Reads which formats and hooks are trending *in this account's own data*
 *      — the only trend signal we genuinely have.
 *   2. Derives durable category patterns from the product's own analysis.
 *
 * Every signal records its `source`, and the UI shows it. Nothing is invented,
 * and no unrelated controversial topic is ever surfaced as an opportunity.
 */
import 'server-only';
import { type TenantScope } from '../db';
import { db, getSettings } from '../db/repo';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import { groupBy } from '../optimizer/optimize';
import { postPerformance } from '../analytics/collect';
import type { ContentFormat, Platform, ProductAnalysis, TrendSignal, Uuid } from '../types';

const log = logger('trends');

/**
 * Durable format patterns per category. These are not "trends" in the news
 * sense — they are the content shapes that reliably work for a product type,
 * which is a claim we can stand behind.
 */
const CATEGORY_PATTERNS: Record<string, { label: string; angle: string }[]> = {
  developer: [
    { label: 'Terminal-to-result speedrun', angle: 'Show the command, then the outcome, in under 15 seconds' },
    { label: 'The manual version vs. yours', angle: 'Split screen the old workflow against one command' },
    { label: 'Config file walkthrough', angle: 'Read the config out loud and explain each line' },
  ],
  saas: [
    { label: 'Before/after dashboard', angle: 'Show the spreadsheet, then show the dashboard' },
    { label: 'Day-in-the-life of the workflow', angle: 'Follow one real task end to end' },
    { label: 'The three-click test', angle: 'Prove the whole job takes three clicks' },
  ],
  consumer: [
    { label: 'POV framing', angle: 'POV: you finally found an app that does the thing' },
    { label: 'Green-screen reaction to the problem', angle: 'React to the problem, then reveal the fix' },
    { label: 'Day one vs. day thirty', angle: 'Show what changes after consistent use' },
  ],
  ai: [
    { label: 'Watch it think', angle: 'Screen-record the output arriving in real time' },
    { label: 'One input, everything happens', angle: 'Single input, then the full chain of results' },
    { label: 'What it gets wrong', angle: 'Honest limitations build more trust than hype' },
  ],
};

function patternsFor(category: string): { label: string; angle: string }[] {
  const c = category.toLowerCase();
  if (/ai|llm|agent/.test(c)) return CATEGORY_PATTERNS.ai;
  if (/developer|cli|api|library/.test(c)) return CATEGORY_PATTERNS.developer;
  if (/saas|dashboard|analytics|finance/.test(c)) return CATEGORY_PATTERNS.saas;
  return CATEGORY_PATTERNS.consumer;
}

export interface TrendScanResult {
  signals: TrendSignal[];
  participatable: TrendSignal[];
  note: string;
}

export async function scanTrends(
  scope: TenantScope,
  projectId: Uuid,
  analysis: ProductAnalysis,
): Promise<TrendScanResult> {
  const settings = await getSettings(scope, projectId);
  if (settings && !settings.trend_participation) {
    return {
      signals: [],
      participatable: [],
      note: 'Trend participation is switched off for this project.',
    };
  }

  // Clear the previous scan so the list is current, not cumulative.
  const previous = await db().find(scope, 'trend_signals', { where: { project_id: projectId } });
  for (const p of previous) await db().remove(scope, 'trend_signals', p.id);

  const signals: Omit<TrendSignal, 'id'>[] = [];

  /* 1. What is actually working in this account right now. */
  const performance = await postPerformance(
    scope,
    projectId,
    new Date(Date.now() - 21 * 86_400_000).toISOString(),
  );

  if (performance.length >= 4) {
    const byFormat = groupBy<ContentFormat>(performance, (p) => p.content.format);
    const ranked = byFormat
      .filter((f) => f.samples >= 2)
      .sort((a, b) => b.mean_engagement - a.mean_engagement);

    if (ranked.length >= 2 && ranked[0].mean_engagement > ranked[1].mean_engagement * 1.3) {
      const winner = ranked[0];
      signals.push({
        project_id: projectId,
        platform: dominantPlatformFor(performance, winner.key),
        label: `${winner.key} is your strongest format right now`,
        kind: 'format',
        source: 'platform_api',
        relevance: Math.min(0.95, 0.5 + winner.samples * 0.08),
        can_participate: true,
        participation_angle: `Make more ${winner.key} content — it is averaging ${Math.round(winner.mean_engagement)} engagements against ${Math.round(ranked[1].mean_engagement)} for ${ranked[1].key}.`,
        observed_at: nowIso(),
      });
    }

    // Hook shapes that beat this account's own average.
    const avgEngagement =
      performance.reduce((s, p) => s + p.engagement, 0) / performance.length;
    const winners = performance
      .filter((p) => p.engagement > avgEngagement * 1.5)
      .slice(0, 3);
    for (const w of winners) {
      const shape = hookShape(w.content.hook);
      if (!shape) continue;
      signals.push({
        project_id: projectId,
        platform: w.content.platform,
        label: `"${shape}" hooks are over-performing`,
        kind: 'conversation',
        source: 'platform_api',
        relevance: 0.7,
        can_participate: true,
        participation_angle: `Reuse this hook structure on a different feature: "${w.content.hook.slice(0, 80)}"`,
        observed_at: nowIso(),
      });
    }
  }

  /* 2. Durable category patterns the product can legitimately join. */
  for (const pattern of patternsFor(analysis.category)) {
    const relevant = canParticipate(pattern.label, analysis);
    signals.push({
      project_id: projectId,
      platform: 'tiktok',
      label: pattern.label,
      kind: 'format',
      source: 'category_pattern',
      relevance: relevant ? 0.6 : 0.3,
      can_participate: relevant,
      participation_angle: relevant ? pattern.angle : null,
      observed_at: nowIso(),
    });
  }

  /* 3. Keywords the repository itself supports — grounded, not guessed. */
  for (const feature of analysis.features.filter((f) => f.user_facing).slice(0, 3)) {
    signals.push({
      project_id: projectId,
      platform: 'instagram',
      label: feature.name,
      kind: 'keyword',
      source: 'repo_context',
      relevance: 0.55,
      can_participate: true,
      participation_angle: `Build a post around ${feature.name.toLowerCase()} — it is evidenced in the repo, so the claim holds.`,
      observed_at: nowIso(),
    });
  }

  const saved = await db().insertMany(
    scope,
    'trend_signals',
    signals.map((s) => ({ ...s, id: newId() })),
  );

  log.info('trend scan complete', { projectId, signals: saved.length });

  return {
    signals: saved,
    participatable: saved.filter((s) => s.can_participate),
    note:
      'Instagram and TikTok do not expose a general trending-topics API to content-posting ' +
      'clients, so these signals come from your own performance data, your repository, and ' +
      'durable format patterns for your category — not from invented trends.',
  };
}

/** Only participate where the product genuinely fits the format. */
function canParticipate(pattern: string, analysis: ProductAnalysis): boolean {
  const p = pattern.toLowerCase();
  const hasScreens = analysis.screens.length > 0;
  const hasVisual = analysis.platforms.some((pl) => /web|ios|android|desktop/i.test(pl));

  if (/dashboard|screen|walkthrough|click/.test(p)) return hasScreens && hasVisual;
  if (/terminal|config|command/.test(p)) return analysis.platforms.includes('CLI');
  if (/day one|day thirty|thirty/.test(p)) return analysis.maturity === 'production';
  return true;
}

function hookShape(hook: string): string | null {
  if (/^POV:/i.test(hook)) return 'POV';
  if (/^\d+\s+(things|ways|reasons)/i.test(hook)) return 'Listicle';
  if (/^(stop|never|don'?t)\b/i.test(hook)) return 'Stop doing X';
  if (/\bvs\.?\b|before\s*\/?\s*after/i.test(hook)) return 'Before/after';
  if (/^(watch|here'?s how|this is how)/i.test(hook)) return 'Demonstration';
  if (/^(nobody|most people|everyone)/i.test(hook)) return 'Contrarian';
  if (/\?$/.test(hook)) return 'Question';
  return null;
}

function dominantPlatformFor(
  performance: Awaited<ReturnType<typeof postPerformance>>,
  format: ContentFormat,
): Platform {
  const match = performance.find((p) => p.content.format === format);
  return match?.content.platform ?? 'instagram';
}
