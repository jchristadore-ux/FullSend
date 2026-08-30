import 'server-only';
import { generateObject } from '../ai/client';
import { type TenantScope } from '../db';
import { db, getSettings, listContent } from '../db/repo';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import { contentBatchSchema } from '../schemas';
import { canAutoPublish, runQualityControl } from '../qc/check';
import { renderCreative } from '../creative/render';
import { buildVideoPackage } from '../video/package';
import { checkDuplicate, contentFingerprint } from './dedup';
import type { Slot } from './mix';
import type { BrandProfile, Campaign, ContentItem, ContentPillar, MarketingStrategy, Persona, PillarType, ProductAnalysis, Project } from '../types';

const log = logger('content');
const CONTENT_SYSTEM = `You are FullSend's content machine. You write social content that a founder would be happy to publish under their own name.

You are given: the verified product analysis, the brand profile, the strategy, the personas, and a list of briefs. Write one post per brief.

Non-negotiable:
- Never claim a capability that is not in the product's verified feature list.
- The hook is the first line a stranger reads. It must earn the second line. No "In today's world", no "Are you tired of", no rhetorical throat-clearing.
- Write in the brand's voice. Use its words_to_use. Never use its words_to_avoid.
- Demo content must reference the actual screens supplied, by name.
- Instagram is the only active production platform. Do not generate TikTok, LinkedIn, X, Facebook, Pinterest or YouTube content.
- Every post gets exactly one call to action.
- Hashtags are relevant and specific. No hashtag soup.
- For video formats, write the full scene-by-scene plan with real timings.
- Each post must be meaningfully different from the others in this batch.

Return JSON only.`;

export interface GenerateContentInput {
  project: Project; analysis: ProductAnalysis; brand: BrandProfile; strategy: MarketingStrategy; personas: Persona[];
  pillars: ContentPillar[]; campaigns: Campaign[]; slots: Slot[]; origin?: ContentItem['origin']; brief?: string;
}
export interface GenerateContentResult { created: ContentItem[]; rejectedDuplicates: number; blockedByQc: number; costUsd: number; }

// Six posts is a bounded durable unit: large enough to preserve the existing
// generation contract, small enough that a single AI failure does not consume
// an entire calendar run.
const BATCH_SIZE = 6;

export async function generateContent(scope: TenantScope, input: GenerateContentInput): Promise<GenerateContentResult> {
  const { project, analysis, brand, strategy, personas, pillars, campaigns, slots } = input;
  if (slots.length === 0) return { created: [], rejectedDuplicates: 0, blockedByQc: 0, costUsd: 0 };
  const settings = await getSettings(scope, project.id);
  const existing = await listContent(scope, project.id);
  const seen = existing.map((c) => ({ id: c.id, platform: c.platform, hook: c.hook, caption: c.caption, dedup_hash: c.dedup_hash }));
  const recent = existing.slice(-30).map((c) => ({ hook: c.hook, caption: c.caption }));
  const created: ContentItem[] = []; let rejectedDuplicates = 0; let blockedByQc = 0; let costUsd = 0;
  const batch = slots.slice(0, BATCH_SIZE);
  const briefs = batch.map((slot, i) => {
    const pillar = pickPillar(pillars, slot.pillarType); const campaign = pickCampaign(campaigns, slot.at); const persona = personas[i % Math.max(1, personas.length)];
    return { seed: `${project.id}:${slot.at.toISOString()}:instagram`, platform: 'instagram', format: slot.format, pillar_type: slot.pillarType, pillar_name: pillar?.name ?? slot.pillarType, campaign: campaign?.name ?? null, campaign_angle: campaign?.angle ?? null, persona: persona?.name ?? null, topic: pickTopic(pillar, analysis, i), scheduled_for: slot.at.toISOString() };
  });
  const { data, costUsd: batchCost } = await generateObject({
    task: 'content.batch', system: CONTENT_SYSTEM, brief: input.brief ?? `Write ${briefs.length} Instagram posts for ${project.name}. Each must be publishable as-is.`,
    context: {
      project_name: project.name,
      analysis: { one_liner: analysis.one_liner, what_it_does: analysis.what_it_does, category: analysis.category, features: analysis.features, not_capabilities: analysis.not_capabilities, differentiators: analysis.differentiators, problem_solved: analysis.problem_solved, tech_stack: analysis.tech_stack, screens: analysis.screens },
      brand: { voice: brand.voice, tone_attributes: brand.tone_attributes, messaging_pillars: brand.messaging_pillars, words_to_use: brand.words_to_use, words_to_avoid: brand.words_to_avoid, ctas: brand.ctas, emoji_policy: brand.emoji_policy, terminology: brand.terminology },
      strategy: { positioning: strategy.positioning, value_proposition: strategy.value_proposition, cta_strategy: strategy.cta_strategy },
      personas: personas.map((p) => ({ name: p.name, role: p.role, pain_points: p.pain_points, objections: p.objections, tone_preference: p.tone_preference })),
      existing_hooks: existing.slice(-40).map((c) => c.hook), briefs,
    },
    schema: contentBatchSchema, noCache: true, maxTokens: 9000,
    attribution: { scope, projectId: project.id, userId: project.user_id },
  });
  costUsd += batchCost;
  for (let i = 0; i < batch.length; i++) {
    const slot = batch[i]; const generated = data.items[i]; if (!generated) continue;
    const candidate = { platform: 'instagram' as const, format: slot.format, hook: generated.hook, caption: generated.caption };
    const verdict = checkDuplicate(candidate, seen); if (!verdict.unique) { rejectedDuplicates++; continue; }
    const pillar = pickPillar(pillars, slot.pillarType); const campaign = pickCampaign(campaigns, slot.at); const persona = personas[i % Math.max(1, personas.length)];
    const videoPlan = generated.video_plan ?? (needsVideo(slot.format) ? buildVideoPackage({ hook: generated.hook, caption: generated.caption, cta: generated.cta, analysis, platform: 'instagram' }) : null);
    const qc = runQualityControl({ item: { platform: 'instagram', format: slot.format, hook: generated.hook, caption: generated.caption, cta: generated.cta, hashtags: generated.hashtags, video_plan: videoPlan, slides: generated.slides }, analysis, brand, recent });
    const decision = canAutoPublish(qc, project.autopilot_mode, slot.pillarType, settings?.require_approval_for_promotion ?? true);
    const status: ContentItem['status'] = !qc.passed ? 'review_required' : decision.allowed ? 'approved' : 'approval_required'; if (!qc.passed) blockedByQc++;
    const item: ContentItem = {
      id: newId(), project_id: project.id, campaign_id: campaign?.id ?? null, pillar_id: pillar?.id ?? null, persona_id: persona?.id ?? null,
      platform: 'instagram', format: slot.format, hook: generated.hook, script: generated.script, caption: generated.caption, cta: generated.cta, hashtags: generated.hashtags,
      video_plan: videoPlan, slides: generated.slides, creative_asset_ids: [], status, dedup_hash: contentFingerprint(candidate), qc,
      scheduled_for: slot.at.toISOString(), published_at: null, origin: input.origin ?? 'initial', ai_cost_usd: Math.round((batchCost / Math.max(1, batch.length)) * 1e6) / 1e6, created_at: nowIso(), updated_at: nowIso(),
    };
    const saved = await db().insert(scope, 'content_items', item);
    const assets = await renderCreative(scope, { project, item: saved, brand, analysis });
    if (assets.length) { await db().update(scope, 'content_items', saved.id, { creative_asset_ids: assets.map((a) => a.id) }); saved.creative_asset_ids = assets.map((a) => a.id); }
    created.push(saved); seen.push({ id: saved.id, platform: saved.platform, hook: saved.hook, caption: saved.caption, dedup_hash: saved.dedup_hash }); recent.push({ hook: saved.hook, caption: saved.caption });
  }
  log.info('content generated', { project: project.id, created: created.length, duplicates: rejectedDuplicates, qcBlocked: blockedByQc, cost: costUsd });
  return { created, rejectedDuplicates, blockedByQc, costUsd };
}
function needsVideo(format: string): boolean { return format === 'reel' || format === 'short_video' || format === 'story'; }
function pickPillar(pillars: ContentPillar[], type: PillarType): ContentPillar | null { return pillars.filter((p) => p.type === type)[0] ?? pillars[0] ?? null; }
function pickCampaign(campaigns: Campaign[], at: Date): Campaign | null { const t = at.getTime(); return campaigns.find((c) => Date.parse(c.starts_at) <= t && Date.parse(c.ends_at) >= t) ?? campaigns.find((c) => c.status === 'active') ?? campaigns[0] ?? null; }
function pickTopic(pillar: ContentPillar | null, analysis: ProductAnalysis, index: number): string { const topics = pillar?.example_topics ?? []; if (topics.length) return topics[index % topics.length]; const features = analysis.features.filter((f) => f.user_facing); if (features.length) return features[index % features.length].name; return analysis.category; }
