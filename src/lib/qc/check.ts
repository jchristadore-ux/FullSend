/**
 * Quality control.
 *
 * The gate between "the machine wrote something" and "it goes on the internet
 * under the founder's name". Runs before anything is scheduled and again before
 * anything is published. A `block` finding stops publishing outright; a `warn`
 * routes to human review. Nothing questionable ever publishes silently.
 */

import { nowIso } from '../ids';
import { similarity } from '../content/dedup';
import type {
  BrandProfile,
  ContentItem,
  ProductAnalysis,
  QcFinding,
  QcResult,
  Platform,
} from '../types';

/** Platform limits that would cause an outright API rejection. */
export const PLATFORM_LIMITS: Record<
  Platform,
  { caption: number; hashtags: number; videoSeconds?: number }
> = {
  instagram: { caption: 2200, hashtags: 30, videoSeconds: 90 },
  tiktok: { caption: 2200, hashtags: 30, videoSeconds: 600 },
  youtube_shorts: { caption: 5000, hashtags: 15, videoSeconds: 60 },
  linkedin: { caption: 3000, hashtags: 10 },
  facebook: { caption: 5000, hashtags: 30 },
  x: { caption: 280, hashtags: 5 },
  pinterest: { caption: 500, hashtags: 20 },
};

/**
 * Claim patterns that need substantiation. These are what turn a caption into
 * a legal problem, so they are matched conservatively and always surfaced.
 */
const UNSUPPORTED_CLAIM_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b\d+(?:\.\d+)?\s*(?:x|times)\s+(?:faster|better|cheaper|more)\b/i, label: 'multiplier claim' },
  { re: /\b(?:save|saves|saved)\s+\d+\s*(?:%|percent|hours?|days?|weeks?)\b/i, label: 'quantified saving' },
  { re: /\b\d[\d,.]*\s*(?:\+|k|m)?\s*(?:users|customers|downloads|installs|companies)\b/i, label: 'user-count claim' },
  // `#1` needs its own alternative: \b does not anchor before a `#`.
  {
    re: /(?:#\s?1(?!\d)|\bnumber one\b|\bbest[- ]in[- ]class\b|\bworld'?s (?:best|first|only)\b|\bmarket leader\b)/i,
    label: 'superiority claim',
  },
  { re: /\b(?:guaranteed?|guarantee|100%\s*(?:accurate|reliable|secure|uptime))\b/i, label: 'guarantee' },
  { re: /\b(?:cures?|treats?|prevents?|diagnoses?)\b/i, label: 'health claim' },
  { re: /\b(?:\$[\d,]+(?:k|m)?\s*(?:in\s+)?(?:revenue|mrr|arr|profit))\b/i, label: 'revenue claim' },
  { re: /\b(?:risk[- ]free|no risk|instant results?|overnight)\b/i, label: 'outcome guarantee' },
];

const MISLEADING_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b(?:limited time|only \d+ (?:spots?|left)|act now|last chance)\b/i, label: 'false urgency' },
  { re: /\bfree\b(?![\s-]*(?:trial|tier|plan|forever|and open))/i, label: 'unqualified "free"' },
  { re: /\b(?:doctors?|experts?|scientists?)\s+(?:hate|don'?t want)\b/i, label: 'clickbait framing' },
];

const SPAM_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /(.)\1{6,}/, label: 'repeated characters' },
  { re: /\b(?:follow\s*(?:for\s*follow|4\s*follow)|f4f|l4l|sub4sub)\b/i, label: 'engagement bait' },
  { re: /\b(?:dm me|click here now|link in bio!!!)\b/i, label: 'spam phrasing' },
  { re: /[A-Z\s!]{40,}/, label: 'shouting' },
];

const PROFANITY = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'piss', 'slut', 'whore',
];

/** Third-party marks that would be a copyright/trademark problem to imply. */
const TRADEMARK_RISK =
  /\b(?:disney|marvel|pokemon|nike|apple music|spotify playlist|netflix|coca[- ]?cola|taylor swift|drake)\b/i;

export interface QcInput {
  item: Pick<
    ContentItem,
    'platform' | 'format' | 'hook' | 'caption' | 'cta' | 'hashtags' | 'video_plan' | 'slides'
  >;
  analysis: Pick<ProductAnalysis, 'features' | 'not_capabilities' | 'one_liner'> | null;
  brand: Pick<BrandProfile, 'words_to_avoid' | 'words_to_use' | 'emoji_policy'> | null;
  /** Recent posts, used to catch the machine repeating itself. */
  recent?: { hook: string; caption: string }[];
}

export function runQualityControl(input: QcInput): QcResult {
  const { item, analysis, brand } = input;
  const findings: QcFinding[] = [];
  const text = `${item.hook}\n${item.caption}\n${item.cta}`;
  const limits = PLATFORM_LIMITS[item.platform];

  /* Unsupported product claims. */
  for (const { re, label } of UNSUPPORTED_CLAIM_PATTERNS) {
    const m = text.match(re);
    if (m) {
      findings.push({
        check: 'unsupported_claim',
        severity: 'block',
        message: `Contains a ${label} that the product analysis cannot substantiate.`,
        excerpt: m[0],
      });
    }
  }

  /* Claims outside the verified feature set. */
  if (analysis) {
    const featureWords = new Set(
      analysis.features.flatMap((f) => f.name.toLowerCase().split(/\s+/)).filter((w) => w.length > 3),
    );
    for (const nope of analysis.not_capabilities) {
      const key = nope.toLowerCase().split(/\s+/).filter((w) => w.length > 4)[0];
      if (key && !featureWords.has(key) && new RegExp(`\\b${escapeRe(key)}\\b`, 'i').test(text)) {
        findings.push({
          check: 'overclaim',
          severity: 'warn',
          message: `Mentions "${key}", which is listed as something the product does not do.`,
          excerpt: nope,
        });
      }
    }
  }

  /* Misleading framing. */
  for (const { re, label } of MISLEADING_PATTERNS) {
    const m = text.match(re);
    if (m) {
      findings.push({
        check: 'misleading',
        severity: 'warn',
        message: `Possible ${label}.`,
        excerpt: m[0],
      });
    }
  }

  /* Copyright / trademark. */
  const tm = text.match(TRADEMARK_RISK);
  if (tm) {
    findings.push({
      check: 'copyright',
      severity: 'warn',
      message: `References a third-party brand ("${tm[0]}"). Confirm you have the right to use it.`,
      excerpt: tm[0],
    });
  }
  if (item.video_plan?.music_direction && /\b(?:use|licensed?)\s+(?:the\s+)?(?:song|track)\b/i.test(item.video_plan.music_direction)) {
    findings.push({
      check: 'copyright',
      severity: 'warn',
      message: 'Video plan references a specific track. Use platform-licensed audio only.',
    });
  }

  /* Profanity. */
  const lower = text.toLowerCase();
  const swear = PROFANITY.find((w) => new RegExp(`\\b${w}`, 'i').test(lower));
  if (swear) {
    findings.push({
      check: 'profanity',
      severity: 'warn',
      message: `Contains profanity ("${swear}"). Platforms may suppress reach.`,
      excerpt: swear,
    });
  }

  /* Spam signals. */
  for (const { re, label } of SPAM_PATTERNS) {
    const m = text.match(re);
    if (m) {
      findings.push({
        check: 'spam',
        severity: 'warn',
        message: `Reads as spam: ${label}.`,
        excerpt: String(m[0]).slice(0, 60),
      });
    }
  }

  /* Repetition against recent posts.
   *
   * Weighted the same way the dedup guard weighs it — the hook is what a
   * viewer actually sees, so two posts on the same topic with different hooks
   * are two posts, not a repeat. Comparing captions alone flags every post
   * that shares boilerplate. */
  if (input.recent?.length) {
    const worst = input.recent.reduce((max, r) => {
      const score = similarity(item.hook, r.hook) * 0.65 + similarity(item.caption, r.caption) * 0.35;
      return Math.max(max, score);
    }, 0);
    if (worst >= 0.62) {
      findings.push({
        check: 'repetitive',
        severity: 'block',
        message: `Too close to a recent post (${Math.round(worst * 100)}% overlap).`,
      });
    } else if (worst >= 0.45) {
      findings.push({
        check: 'repetitive',
        severity: 'warn',
        message: `Similar to a recent post (${Math.round(worst * 100)}% overlap).`,
      });
    }
  }

  /* Platform requirements — these are hard rejections at the API. */
  if (item.caption.length > limits.caption) {
    findings.push({
      check: 'platform_requirements',
      severity: 'block',
      message: `Caption is ${item.caption.length} characters; ${item.platform} allows ${limits.caption}.`,
    });
  }
  if (item.hashtags.length > limits.hashtags) {
    findings.push({
      check: 'platform_requirements',
      severity: 'block',
      message: `${item.hashtags.length} hashtags; ${item.platform} allows ${limits.hashtags}.`,
    });
  }
  if (item.hashtags.some((h) => !/^#[\wÀ-ɏ]+$/u.test(h))) {
    findings.push({
      check: 'platform_requirements',
      severity: 'warn',
      message: 'One or more hashtags contain characters platforms will strip.',
    });
  }
  if (
    limits.videoSeconds &&
    item.video_plan &&
    item.video_plan.total_duration_seconds > limits.videoSeconds
  ) {
    findings.push({
      check: 'platform_requirements',
      severity: 'block',
      message: `Video is ${item.video_plan.total_duration_seconds}s; ${item.platform} allows ${limits.videoSeconds}s.`,
    });
  }
  if (item.format === 'carousel' && (!item.slides || item.slides.length < 2)) {
    findings.push({
      check: 'platform_requirements',
      severity: 'block',
      message: 'A carousel needs at least two slides.',
    });
  }
  if (item.format === 'carousel' && item.slides && item.slides.length > 10) {
    findings.push({
      check: 'platform_requirements',
      severity: 'block',
      message: `Carousels are capped at 10 slides; this has ${item.slides.length}.`,
    });
  }

  /* Brand consistency. */
  if (brand) {
    const banned = brand.words_to_avoid.filter((w) =>
      w.length > 2 ? new RegExp(`\\b${escapeRe(w)}\\b`, 'i').test(text) : false,
    );
    for (const w of banned.slice(0, 5)) {
      findings.push({
        check: 'brand_consistency',
        severity: 'warn',
        message: `Uses "${w}", which this brand avoids.`,
        excerpt: w,
      });
    }
    const emojiCount = countEmoji(text);
    if (brand.emoji_policy === 'none' && emojiCount > 0) {
      findings.push({
        check: 'brand_consistency',
        severity: 'warn',
        message: `Brand voice uses no emoji; found ${emojiCount}.`,
      });
    }
    if (brand.emoji_policy === 'sparing' && emojiCount > 3) {
      findings.push({
        check: 'brand_consistency',
        severity: 'warn',
        message: `Brand voice is sparing with emoji; found ${emojiCount}.`,
      });
    }
  }

  /* Basic completeness — an empty hook is a broken post, not a stylistic choice. */
  if (item.hook.trim().length < 5) {
    findings.push({ check: 'factual_accuracy', severity: 'block', message: 'Hook is empty.' });
  }
  if (item.caption.trim().length < 10) {
    findings.push({ check: 'factual_accuracy', severity: 'block', message: 'Caption is empty.' });
  }
  if (/\{[a-z_]+\}|\[insert|lorem ipsum|TODO/i.test(text)) {
    findings.push({
      check: 'factual_accuracy',
      severity: 'block',
      message: 'Contains an unfilled template placeholder.',
    });
  }

  const blocks = findings.filter((f) => f.severity === 'block');
  const warns = findings.filter((f) => f.severity === 'warn');
  const score = Math.max(0, 100 - blocks.length * 34 - warns.length * 9);

  return {
    passed: blocks.length === 0,
    // Anything flagged goes to a human. Warnings are never auto-dismissed.
    requires_human_review: blocks.length > 0 || warns.length > 0,
    score,
    findings: findings.length
      ? findings
      : [{ check: 'all', severity: 'pass', message: 'All checks passed.' }],
    checked_at: nowIso(),
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countEmoji(s: string): number {
  return (s.match(/\p{Extended_Pictographic}/gu) ?? []).length;
}

/**
 * Whether this item may publish without a human, given the autopilot mode.
 * `full_send` still refuses on a block — autonomy is not the same as reckless.
 */
export function canAutoPublish(
  qc: QcResult,
  mode: 'manual' | 'hybrid' | 'full_send',
  pillarType: string,
  requireApprovalForPromotion: boolean,
): { allowed: boolean; reason: string } {
  if (!qc.passed) {
    return { allowed: false, reason: 'Quality control blocked this post' };
  }
  if (mode === 'manual') {
    return { allowed: false, reason: 'Manual mode — every post needs approval' };
  }
  const isPromotional = pillarType === 'promotion';
  if (mode === 'hybrid' && isPromotional && requireApprovalForPromotion) {
    return { allowed: false, reason: 'Hybrid mode — promotional content needs approval' };
  }
  if (qc.requires_human_review) {
    return { allowed: false, reason: 'Quality control raised a warning for review' };
  }
  if (mode === 'full_send' && isPromotional && requireApprovalForPromotion) {
    return { allowed: false, reason: 'Promotional content is set to require approval' };
  }
  return { allowed: true, reason: 'Cleared for autopilot' };
}
