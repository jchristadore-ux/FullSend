/**
 * Validation schemas for AI output and API input.
 *
 * Every generation is parsed through one of these before it can reach the
 * database, so a malformed model response fails loudly at the boundary instead
 * of quietly corrupting a calendar.
 */
import { z } from 'zod';
import { CONTENT_FORMATS, PLATFORMS } from './types';

export const platformSchema = z.enum(PLATFORMS);
export const formatSchema = z.enum(CONTENT_FORMATS);
export const pillarTypeSchema = z.enum([
  'education',
  'product_demo',
  'entertainment',
  'social_proof',
  'promotion',
]);

/* ── Product analysis ───────────────────────────────────────────────────── */

export const productFeatureSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(400),
  evidence: z.array(z.string()).default([]),
  user_facing: z.boolean().default(true),
});

export const productAnalysisSchema = z.object({
  one_liner: z.string().min(5).max(240),
  what_it_does: z.string().min(10).max(1500),
  category: z.string().min(2).max(80),
  features: z.array(productFeatureSchema).max(15).default([]),
  not_capabilities: z.array(z.string()).max(15).default([]),
  tech_stack: z.array(z.string()).max(20).default([]),
  platforms: z.array(z.string()).max(10).default([]),
  target_market: z.string().max(400).default(''),
  problem_solved: z.string().max(600).default(''),
  differentiators: z.array(z.string()).max(10).default([]),
  maturity: z.enum(['prototype', 'alpha', 'beta', 'production']).default('beta'),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type ProductAnalysisPayload = z.infer<typeof productAnalysisSchema>;

export const personasSchema = z.object({
  personas: z
    .array(
      z.object({
        name: z.string().min(2).max(60),
        role: z.string().max(120).default(''),
        description: z.string().max(600).default(''),
        pain_points: z.array(z.string()).max(8).default([]),
        goals: z.array(z.string()).max(8).default([]),
        objections: z.array(z.string()).max(8).default([]),
        where_they_hang_out: z.array(platformSchema).default([]),
        tone_preference: z.string().max(200).default(''),
        priority: z.number().int().min(1).max(10).default(1),
      }),
    )
    .min(1)
    .max(6),
});
export type PersonasPayload = z.infer<typeof personasSchema>;

/* ── Strategy ───────────────────────────────────────────────────────────── */

export const contentMixSchema = z.object({
  education: z.number().min(0).max(100),
  product_demo: z.number().min(0).max(100),
  entertainment: z.number().min(0).max(100),
  social_proof: z.number().min(0).max(100),
  promotion: z.number().min(0).max(100),
});

export const strategySchema = z.object({
  positioning: z.string().min(10).max(600),
  value_proposition: z.string().min(5).max(400),
  audience_summary: z.string().max(800).default(''),
  pain_points: z.array(z.string()).max(10).default([]),
  differentiators: z.array(z.string()).max(10).default([]),
  campaign_strategy: z.string().max(1200).default(''),
  posting_cadence: z.object({
    instagram_per_week: z.number().min(0).max(21).default(4),
    tiktok_per_week: z.number().min(0).max(21).default(5),
    best_times: z
      .array(
        z.object({
          day: z.number().int().min(0).max(6),
          hour: z.number().int().min(0).max(23),
          platform: platformSchema,
        }),
      )
      .default([]),
  }),
  platform_strategy: z
    .array(
      z.object({
        platform: platformSchema,
        rationale: z.string().max(400).default(''),
        formats: z.array(formatSchema).default([]),
        weight: z.number().min(0).max(100).default(50),
      }),
    )
    .default([]),
  growth_strategy: z.string().max(1200).default(''),
  cta_strategy: z.array(z.string()).max(10).default([]),
  content_mix: contentMixSchema,
  pillars: z
    .array(
      z.object({
        name: z.string().min(2).max(80),
        type: pillarTypeSchema,
        description: z.string().max(400).default(''),
        example_topics: z.array(z.string()).max(8).default([]),
      }),
    )
    .min(1)
    .max(8),
  campaigns: z
    .array(
      z.object({
        name: z.string().min(2).max(80),
        angle: z.string().max(300).default(''),
        goal: z.string().max(300).default(''),
        hypothesis: z.string().max(400).default(''),
      }),
    )
    .min(1)
    .max(8),
});
export type StrategyPayload = z.infer<typeof strategySchema>;

export const brandProfileSchema = z.object({
  voice: z.string().max(600).default(''),
  tone_attributes: z.array(z.string()).max(10).default([]),
  audience: z.string().max(500).default(''),
  messaging_pillars: z.array(z.string()).max(8).default([]),
  terminology: z.record(z.string(), z.string()).default({}),
  visual_style: z.string().max(400).default(''),
  words_to_use: z.array(z.string()).max(30).default([]),
  words_to_avoid: z.array(z.string()).max(40).default([]),
  positioning: z.string().max(600).default(''),
  ctas: z.array(z.string()).max(10).default([]),
  emoji_policy: z.enum(['none', 'sparing', 'liberal']).default('sparing'),
});
export type BrandProfilePayload = z.infer<typeof brandProfileSchema>;

/* ── Content ────────────────────────────────────────────────────────────── */

export const videoSceneSchema = z.object({
  index: z.number().int().min(0),
  duration_seconds: z.number().min(0.5).max(60),
  visual: z.string().max(400),
  on_screen_text: z.string().max(120).default(''),
  narration: z.string().max(600).default(''),
  screen_reference: z.string().nullable().default(null),
});

export const videoPlanSchema = z.object({
  total_duration_seconds: z.number().min(1).max(180),
  hook_text: z.string().max(200),
  scenes: z.array(videoSceneSchema).min(1).max(12),
  narration_script: z.string().max(3000).default(''),
  music_direction: z.string().max(300).default(''),
  cta_text: z.string().max(120).default(''),
  rendered_url: z.string().nullable().default(null),
  render_status: z
    .enum(['not_attempted', 'package_only', 'queued', 'rendered', 'failed'])
    .default('package_only'),
  render_note: z.string().nullable().default(null),
});

export const contentBatchSchema = z.object({
  items: z
    .array(
      z.object({
        platform: platformSchema,
        format: formatSchema,
        pillar_type: pillarTypeSchema,
        hook: z.string().min(3).max(300),
        caption: z.string().min(3).max(2200),
        cta: z.string().max(200).default(''),
        hashtags: z.array(z.string()).max(30).default([]),
        script: z.string().max(4000).nullable().default(null),
        slides: z
          .array(z.object({ headline: z.string().max(120), body: z.string().max(400) }))
          .max(12)
          .nullable()
          .default(null),
        video_plan: videoPlanSchema.nullable().default(null),
      }),
    )
    .max(60),
});
export type ContentBatchPayload = z.infer<typeof contentBatchSchema>;

/* ── Optimizer ──────────────────────────────────────────────────────────── */

export const recommendationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('shift_mix'),
    from: pillarTypeSchema,
    to: pillarTypeSchema,
    points: z.number().min(1).max(40),
  }),
  z.object({
    type: z.literal('increase_format'),
    platform: platformSchema,
    format: formatSchema,
    per_week: z.number().min(1).max(14),
  }),
  z.object({
    type: z.literal('shift_time'),
    platform: platformSchema,
    day: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
  }),
  z.object({ type: z.literal('favor_hook_style'), style: z.string().max(120) }),
  z.object({
    type: z.literal('increase_platform_weight'),
    platform: platformSchema,
    points: z.number().min(1).max(50),
  }),
  z.object({
    type: z.literal('generate_content'),
    count: z.number().int().min(1).max(30),
    brief: z.string().max(600),
  }),
]);

export const recommendationsSchema = z.object({
  recommendations: z
    .array(
      z.object({
        statement: z.string().min(5).max(400),
        rationale: z.string().max(800).default(''),
        evidence: z
          .array(z.object({ label: z.string().max(80), value: z.string().max(80) }))
          .max(8)
          .default([]),
        action: recommendationActionSchema,
        confidence: z.number().min(0).max(1).default(0.5),
      }),
    )
    .max(8),
});
export type RecommendationsPayload = z.infer<typeof recommendationsSchema>;

export const weeklyInsightSchema = z.object({
  biggest_learning: z.string().min(5).max(600),
  next_week_strategy: z.string().min(5).max(900),
});

export const trendScanSchema = z.object({
  signals: z
    .array(
      z.object({
        label: z.string().max(120),
        kind: z.enum(['topic', 'format', 'keyword', 'conversation']),
        platform: platformSchema,
        relevance: z.number().min(0).max(1),
        can_participate: z.boolean(),
        participation_angle: z.string().max(400).nullable().default(null),
      }),
    )
    .max(20),
});

/* ── API input ──────────────────────────────────────────────────────────── */

export const createProjectInput = z.object({
  repository: z.string().min(3).max(300),
  name: z.string().min(1).max(80).optional(),
  timezone: z.string().max(60).default('UTC'),
  autopilot_mode: z.enum(['manual', 'hybrid', 'full_send']).default('full_send'),
});

export const generateCalendarInput = z.object({
  days: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(60), z.literal(90)]),
  platforms: z.array(platformSchema).min(1).optional(),
});

export const approveStrategyInput = z.object({
  positioning: z.string().max(600).optional(),
  value_proposition: z.string().max(400).optional(),
  campaign_strategy: z.string().max(1200).optional(),
  growth_strategy: z.string().max(1200).optional(),
  content_mix: contentMixSchema.optional(),
  posting_cadence: strategySchema.shape.posting_cadence.optional(),
});

export const updateContentInput = z.object({
  hook: z.string().max(300).optional(),
  caption: z.string().max(2200).optional(),
  cta: z.string().max(200).optional(),
  hashtags: z.array(z.string()).max(30).optional(),
  scheduled_for: z.string().datetime().optional(),
  status: z
    .enum([
      'draft',
      'approval_required',
      'approved',
      'scheduled',
      'publishing',
      'published',
      'failed',
      'review_required',
    ])
    .optional(),
});

export const settingsInput = z.object({
  autopilot_mode: z.enum(['manual', 'hybrid', 'full_send']).optional(),
  timezone: z.string().max(60).optional(),
  daily_post_cap: z.number().int().min(1).max(10).optional(),
  require_approval_for_promotion: z.boolean().optional(),
  trend_participation: z.boolean().optional(),
  notify_email: z.boolean().optional(),
  quiet_hours: z
    .object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) })
    .nullable()
    .optional(),
});
