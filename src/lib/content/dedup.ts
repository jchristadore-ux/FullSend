/**
 * Duplicate prevention.
 *
 * An autonomous content machine's worst failure mode is quietly posting the
 * same thing twice. Two guards: an exact fingerprint that the database enforces
 * as a unique index, and a similarity check that catches near-duplicates the
 * fingerprint would miss.
 */

import { sha256 } from '../ids';
import type { ContentItem, Platform } from '../types';

/** Stopwords are dropped so wording changes don't hide a repeated idea. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'it', 'its',
  'this', 'that', 'these', 'those', 'you', 'your', 'i', 'we', 'our', 'my', 'me',
  'do', 'does', 'did', 'so', 'if', 'then', 'than', 'how', 'what', 'why', 'when',
]);

export function normalizeText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/#\w+/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * The fingerprint. Keyed on platform + format + the meaningful words of the
 * hook, because two posts with the same hook on the same surface are the same
 * post however differently the caption is written.
 */
export function contentFingerprint(input: {
  platform: Platform;
  format: string;
  hook: string;
}): string {
  const words = normalizeText(input.hook).sort().join(' ');
  return sha256(`${input.platform}|${input.format}|${words}`);
}

/** Jaccard similarity over normalised word sets. */
export function similarity(a: string, b: string): number {
  const setA = new Set(normalizeText(a));
  const setB = new Set(normalizeText(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared++;
  return shared / (setA.size + setB.size - shared);
}

export const SIMILARITY_THRESHOLD = 0.62;

export interface DedupVerdict {
  unique: boolean;
  reason: string | null;
  conflictsWith: string | null;
  similarityScore: number;
}

/**
 * Checks a candidate against everything already generated for the project.
 * Only compares against the same platform — the same idea told for Instagram
 * and TikTok is two legitimate posts, not a duplicate.
 */
export function checkDuplicate(
  candidate: { platform: Platform; format: string; hook: string; caption: string },
  existing: Pick<ContentItem, 'id' | 'platform' | 'hook' | 'caption' | 'dedup_hash'>[],
): DedupVerdict {
  const fingerprint = contentFingerprint(candidate);

  const exact = existing.find((e) => e.dedup_hash === fingerprint);
  if (exact) {
    return {
      unique: false,
      reason: 'An identical hook already exists for this platform',
      conflictsWith: exact.id,
      similarityScore: 1,
    };
  }

  let worst = 0;
  let worstId: string | null = null;
  for (const e of existing) {
    if (e.platform !== candidate.platform) continue;
    const hookScore = similarity(candidate.hook, e.hook);
    const bodyScore = similarity(candidate.caption, e.caption);
    // The hook is what the viewer actually sees first, so weight it heavier.
    const score = hookScore * 0.65 + bodyScore * 0.35;
    if (score > worst) {
      worst = score;
      worstId = e.id;
    }
  }

  if (worst >= SIMILARITY_THRESHOLD) {
    return {
      unique: false,
      reason: `Too similar to existing content (${Math.round(worst * 100)}% overlap)`,
      conflictsWith: worstId,
      similarityScore: worst,
    };
  }

  return { unique: true, reason: null, conflictsWith: null, similarityScore: worst };
}
