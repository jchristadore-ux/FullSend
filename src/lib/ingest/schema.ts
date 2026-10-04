/**
 * The ingest payload, validated with zod like every other FullSend input.
 *
 * `facts` is deliberately a closed shape: unknown keys are stripped before
 * anything is stored or written into a caption, so a sender cannot widen what
 * personal data FullSend holds just by adding a field. The only people-data
 * accepted is a display name.
 */
import { z } from 'zod';

export const INGEST_PROJECTS = ['brovisional'] as const;
export const INGEST_EVENT_TYPES = ['round_result', 'handicap_drop', 'weekly_leaderboard'] as const;
export type IngestEventType = (typeof INGEST_EVENT_TYPES)[number];

/** `brovisional:<event_type>:<id>` — the id is the sender's own stable key. */
export const IDEMPOTENCY_KEY_RE =
  /^brovisional:(round_result|handicap_drop|weekly_leaderboard):[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const displayName = z.string().trim().min(1).max(80);
const num = z.number().finite();
const hexColor = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, 'must be a hex colour like #0B6E4F');
const httpsUrl = z
  .string()
  .max(2048)
  .url()
  .refine((u) => u.startsWith('https://'), 'must be an https:// URL');

export const leaderboardRow = z.object({
  rank: z.number().int().min(1).max(1000),
  display_name: displayName,
  index: num.optional(),
  delta: num.optional(),
  score: num.optional(),
  differential: num.optional(),
});

export const factsSchema = z.object({
  /** Display names only — the names shown on the card. */
  players: z.array(z.object({ display_name: displayName })).max(20).default([]),
  course: z.string().trim().min(1).max(120).optional(),
  score: num.optional(),
  differential: num.optional(),
  index: num.optional(),
  delta: num.optional(),
  leaderboard: z.array(leaderboardRow).max(50).optional(),
});
export type IngestFacts = z.infer<typeof factsSchema>;

export const ingestPostSchema = z
  .object({
    project: z.enum(INGEST_PROJECTS),
    event_type: z.enum(INGEST_EVENT_TYPES),
    idempotency_key: z.string().regex(IDEMPOTENCY_KEY_RE, 'must look like brovisional:<event_type>:<id>'),
    image_url: httpsUrl,
    alt_text: z.string().trim().min(1).max(1000),
    caption_hint: z.string().trim().max(1500).default(''),
    facts: factsSchema,
    brand: z.object({
      primary: hexColor,
      accent: hexColor,
      logo_url: httpsUrl.nullable().optional(),
    }),
    scheduled_for: z.string().datetime({ offset: true }).nullable().optional(),
    group_id: z.string().trim().min(1).max(200),
  })
  .superRefine((v, ctx) => {
    if (!v.idempotency_key.startsWith(`brovisional:${v.event_type}:`)) {
      ctx.addIssue({
        code: 'custom',
        path: ['idempotency_key'],
        message: `must start with brovisional:${v.event_type}:`,
      });
    }
  });
export type IngestPost = z.infer<typeof ingestPostSchema>;

/** Flattened, sender-readable validation details. */
export function issueDetails(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.slice(0, 20).map((i) => ({
    path: i.path.join('.') || '(body)',
    message: i.message,
  }));
}
