/**
 * Marketing strategy and brand profile.
 *
 * Everything downstream — pillars, campaigns, every caption — reads from what
 * this produces, so it is generated once and then reused from the durable job.
 */
import 'server-only';
import { generateObject } from '../ai/client';
import { FULLSEND_VOICE } from '../brand/fullsend-brand';
import { type TenantScope } from '../db';
import { db, getBrandProfile, getStrategy } from '../db/repo';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import { brandProfileSchema, strategySchema } from '../schemas';
import type {
  BrandProfile,
  Campaign,
  ContentMix,
  ContentPillar,
  MarketingStrategy,
  Persona,
  PillarType,
  ProductAnalysis,
  Project,
} from '../types';

const log = logger('strategy');

const STRATEGY_SYSTEM = `You are FullSend's head of marketing strategy.

You are given a verified product analysis and its audience. Produce the strategy
that an experienced founder-marketer would actually run for this product on
INSTAGRAM ONLY.

Hold to these:
- Instagram is the only production platform in scope. Do not create strategy,
  cadence, campaigns, or recommendations for TikTok, LinkedIn, X, Facebook,
  Pinterest, YouTube, or any other platform.
- Positioning must be specific enough that a competitor could not claim it.
- The content mix must total 100 and must fit THIS product. A developer tool
  earns more education; a consumer app earns more entertainment. Do not return
  the same split for every product.
- Use ONLY these exact pillar types: education, product_demo, entertainment,
  social_proof, promotion. Do not invent alternate labels such as educational,
  demo, testimonial, sales, or product-demonstration.
- Include all five content_mix fields: education, product_demo, entertainment,
  social_proof, promotion. Values are percentages and must total 100.
- Pillars are what you post about week after week, not campaign names. Every
  pillar must have a type from the exact five-value list above.
- Campaigns are time-boxed Instagram angles with a testable hypothesis.
- Cadence must be sustainable by one person with an automated system, and
  posting_cadence must be present with instagram_per_week set.
- value_proposition is required: one sentence, what the product gives someone
  and why they should care.
- No jargon. No "leverage", no "unlock", no "in today's landscape".

Return JSON only.`;

const BRAND_SYSTEM = `You are FullSend's brand director.

Define the persistent voice for this product: how it sounds, what words it uses,
what words it never uses. This profile is attached to every single post the
machine generates, so it must be concrete and enforceable, not aspirational.

"words_to_avoid" should include the specific AI-slop phrases that would make
this product's content sound generated, plus anything off-brand for its audience.

Instagram is the only production platform in scope.

Return JSON only.`;

export interface StrategyResult {
  strategy: MarketingStrategy;
  pillars: ContentPillar[];
  campaigns: Campaign[];
  brand: BrandProfile | null;
  costUsd: number;
}

export async function buildStrategy(
  scope: TenantScope,
  project: Project,
  analysis: ProductAnalysis,
  personas: Persona[] = [],
  opts: { refresh?: boolean } = {},
): Promise<StrategyResult> {
  if (!opts.refresh) {
    const [existing, existingBrand] = await Promise.all([
      getStrategy(scope, project.id),
      getBrandProfile(scope, project.id),
    ]);
    if (existing) {
      const [pillars, campaigns] = await Promise.all([
        db().find(scope, 'content_pillars', { where: { project_id: project.id } }),
        db().find(scope, 'campaigns', { where: { project_id: project.id } }),
      ]);
      log.info('reusing the saved marketing plan', { project: project.id, version: existing.version });
      return { strategy: existing, pillars, campaigns, brand: existingBrand ?? null, costUsd: 0 };
    }
  }

  const { data, costUsd: strategyCost } = await generateObject({
    task: 'strategy.build',
    system: STRATEGY_SYSTEM,
    brief: `Build the Instagram marketing strategy for ${project.name}.`,
    context: {
      project_name: project.name,
      production_platform: 'instagram',
      analysis: {
        one_liner: analysis.one_liner,
        what_it_does: analysis.what_it_does,
        category: analysis.category,
        features: analysis.features,
        target_market: analysis.target_market,
        problem_solved: analysis.problem_solved,
        differentiators: analysis.differentiators,
        maturity: analysis.maturity,
        platforms: ['instagram'],
      },
      personas: personas.map((p) => ({
        name: p.name,
        role: p.role,
        pain_points: p.pain_points,
        goals: p.goals,
        objections: p.objections,
        tone_preference: p.tone_preference,
      })),
      screens: analysis.screens.map((s) => ({ name: s.name, purpose: s.purpose })),
    },
    schema: strategySchema,
    attribution: { scope, projectId: project.id, userId: project.user_id },
  });

  const mix = normaliseMix(data.content_mix);
  const prior = await getStrategy(scope, project.id);
  const version = (prior?.version ?? 0) + 1;

  const strategy = await db().insert(scope, 'marketing_strategies', {
    id: newId(),
    project_id: project.id,
    version,
    positioning: data.positioning,
    // Same fallback shape as `differentiators` below: the model's answer when
    // it gave one, the verified analysis when it did not.
    value_proposition: data.value_proposition || analysis.one_liner,
    audience_summary: data.audience_summary,
    pain_points: data.pain_points,
    differentiators: data.differentiators.length ? data.differentiators : analysis.differentiators,
    campaign_strategy: data.campaign_strategy,
    posting_cadence: data.posting_cadence,
    platform_strategy: defaultPlatformStrategy(),
    growth_strategy: data.growth_strategy,
    cta_strategy: data.cta_strategy,
    content_mix: mix,
    approved: false,
    approved_at: null,
    created_at: nowIso(),
  });

  const pillars = await replacePillars(scope, project, data.pillars, mix);
  const campaigns = await replaceCampaigns(scope, project, data.campaigns, personas);

  log.info('strategy built', {
    project: project.id,
    version,
    pillars: pillars.length,
    campaigns: campaigns.length,
  });

  return { strategy, pillars, campaigns, brand: null, costUsd: strategyCost };
}

/** Mixes must total exactly 100 — the calendar allocator depends on it. */
export function normaliseMix(mix: ContentMix): ContentMix {
  const keys = Object.keys(mix) as PillarType[];
  const total = keys.reduce((s, k) => s + (Number(mix[k]) || 0), 0);
  if (total <= 0) {
    return { education: 40, product_demo: 25, entertainment: 15, social_proof: 10, promotion: 10 };
  }
  const scaled = keys.map((k) => ({ k, v: (Number(mix[k]) || 0) * (100 / total) }));
  const rounded = scaled.map((s) => ({ ...s, v: Math.round(s.v) }));
  const drift = 100 - rounded.reduce((s, r) => s + r.v, 0);
  if (drift !== 0) {
    const biggest = rounded.reduce((a, b) => (b.v > a.v ? b : a));
    biggest.v += drift;
  }
  return Object.fromEntries(rounded.map((r) => [r.k, Math.max(0, r.v)])) as ContentMix;
}

function defaultPlatformStrategy() {
  return [
    {
      platform: 'instagram' as const,
      rationale: 'Instagram is the sole production channel; saves, shares, Reels and carousels compound reach.',
      formats: ['reel' as const, 'carousel' as const, 'static' as const],
      weight: 100,
    },
  ];
}

async function replacePillars(
  scope: TenantScope,
  project: Project,
  incoming: { name: string; type: PillarType; description: string; example_topics: string[] }[],
  mix: ContentMix,
): Promise<ContentPillar[]> {
  const existing = await db().find(scope, 'content_pillars', { where: { project_id: project.id } });
  for (const p of existing) await db().remove(scope, 'content_pillars', p.id);

  const byType = new Map<PillarType, number>();
  for (const p of incoming) byType.set(p.type, (byType.get(p.type) ?? 0) + 1);

  return db().insertMany(
    scope,
    'content_pillars',
    incoming.map((p) => ({
      id: newId(),
      project_id: project.id,
      name: p.name,
      type: p.type,
      description: p.description,
      weight: Math.round(mix[p.type] / (byType.get(p.type) || 1)),
      example_topics: p.example_topics,
      created_at: nowIso(),
    })),
  );
}

async function replaceCampaigns(
  scope: TenantScope,
  project: Project,
  incoming: { name: string; angle: string; goal: string; hypothesis: string }[],
  personas: Persona[],
): Promise<Campaign[]> {
  const existing = await db().find(scope, 'campaigns', { where: { project_id: project.id } });
  for (const c of existing) {
    if (c.status === 'planned') await db().remove(scope, 'campaigns', c.id);
  }

  const start = new Date();
  return db().insertMany(
    scope,
    'campaigns',
    incoming.map((c, i) => {
      const startsAt = new Date(start.getTime() + i * 14 * 86_400_000);
      const endsAt = new Date(startsAt.getTime() + 14 * 86_400_000);
      return {
        id: newId(),
        project_id: project.id,
        name: c.name,
        angle: c.angle,
        goal: c.goal,
        hypothesis: c.hypothesis,
        target_persona_id: personas[i % Math.max(1, personas.length)]?.id ?? null,
        platforms: ['instagram' as const],
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        status: i === 0 ? ('active' as const) : ('planned' as const),
        created_at: nowIso(),
      };
    }),
  );
}

export async function ensureBrandProfile(
  scope: TenantScope,
  project: Project,
  analysis: ProductAnalysis,
  strategy: MarketingStrategy,
  opts: { refresh?: boolean } = {},
): Promise<{ brand: BrandProfile; costUsd: number }> {
  if (!opts.refresh) {
    const existing = await getBrandProfile(scope, project.id);
    if (existing) return { brand: existing, costUsd: 0 };
  }
  return buildBrandProfile(scope, project, analysis, strategy);
}

export async function buildBrandProfile(
  scope: TenantScope,
  project: Project,
  analysis: ProductAnalysis,
  strategy: MarketingStrategy,
): Promise<{ brand: BrandProfile; costUsd: number }> {
  const { data, costUsd } = await generateObject({
    task: 'brand.profile',
    system: BRAND_SYSTEM,
    brief: `Define the brand voice for ${project.name}.`,
    context: {
      project_name: project.name,
      analysis: {
        category: analysis.category,
        one_liner: analysis.one_liner,
        features: analysis.features.map((f) => ({ name: f.name, description: f.description })),
        differentiators: analysis.differentiators,
      },
      strategy: {
        positioning: strategy.positioning,
        audience_summary: strategy.audience_summary,
        cta_strategy: strategy.cta_strategy,
      },
      baseline_words_to_avoid: FULLSEND_VOICE.wordsToAvoid,
    },
    schema: brandProfileSchema,
    attribution: { scope, projectId: project.id, userId: project.user_id },
  });

  const wordsToAvoid = [...new Set([...FULLSEND_VOICE.wordsToAvoid, ...data.words_to_avoid])];

  const patch = {
    voice: data.voice,
    tone_attributes: data.tone_attributes,
    audience: data.audience || strategy.audience_summary,
    messaging_pillars: data.messaging_pillars,
    terminology: data.terminology,
    visual_style: data.visual_style,
    words_to_use: data.words_to_use,
    words_to_avoid: wordsToAvoid,
    positioning: data.positioning || strategy.positioning,
    ctas: data.ctas.length ? data.ctas : strategy.cta_strategy,
    emoji_policy: data.emoji_policy,
    updated_at: nowIso(),
  };

  const existing = await getBrandProfile(scope, project.id);
  const brand = existing
    ? await db().update(scope, 'brand_profiles', existing.id, patch)
    : await db().insert(scope, 'brand_profiles', {
        id: newId(),
        project_id: project.id,
        primary_color: '#FF5A1F',
        secondary_color: '#FFFFFF',
        background_color: '#08090A',
        ...patch,
      });

  return { brand, costUsd };
}

export async function approveStrategy(
  scope: TenantScope,
  strategyId: string,
  edits: Partial<MarketingStrategy> = {},
): Promise<MarketingStrategy> {
  const patch: Partial<MarketingStrategy> = { ...edits, approved: true, approved_at: nowIso() };
  if (edits.content_mix) patch.content_mix = normaliseMix(edits.content_mix);
  return db().update(scope, 'marketing_strategies', strategyId, patch);
}
