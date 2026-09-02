/**
 * Turning a discovered identity into a stored brand profile — and defending it.
 *
 * Three rules hold this file together, and each one exists because breaking it
 * produced a real failure:
 *
 *  1. **Colours, type and marks are read, never generated.** They come from
 *     `brand/discover.ts` parsing the repository. A model is asked about how a
 *     product *feels* — its personality, its imagery, what it should never do
 *     — because those are judgements about a product it has been shown. It is
 *     never asked what colour the product is, because the answer is in a
 *     stylesheet and a plausible invention is indistinguishable from a reading.
 *
 *  2. **Unknown stays unknown.** No field falls back to FullSend's palette.
 *     That was the actual bug: `#FF5A1F` was written into every project's
 *     profile at insert, so every product FullSend marketed wore FullSend's
 *     colours. Rendering handles absence with a neutral (see `paletteFor`);
 *     storage records it as empty, so the founder can see what was not found.
 *
 *  3. **A human edit is final.** Editing a field locks it. Re-analysis fills
 *     gaps and refreshes what it discovered, and skips every locked field. An
 *     override a later run silently reverts is not an override, and that
 *     silent revert is precisely brand drift.
 */
import 'server-only';
import { logger } from '../logger';
import { nowIso } from '../ids';
import type { BrandIdentity, Discovered } from './discover';
import {
  BRAND_EDITABLE_FIELDS,
  type BrandEditableField,
  type BrandProfile,
  type ProductAnalysis,
} from '../types';

const log = logger('brand.identity');

/**
 * The palette used when a repository stated nothing.
 *
 * Deliberately achromatic. A neutral card is honest about not knowing the
 * product's colour; a card in FullSend's orange is a false claim about someone
 * else's brand, and it is the claim this whole module exists to stop. Ink on
 * paper is also the one palette that cannot clash with a logo dropped onto it.
 */
export const NEUTRAL_PALETTE = {
  accent: '#111111',
  fg: '#111111',
  bg: '#F7F7F5',
  muted: '#6B6B6B',
} as const;

/**
 * A system font stack, for a product whose type could not be read.
 *
 * Every family here is present on the platform that renders the SVG, so the
 * output is predictable rather than silently substituted.
 */
export const NEUTRAL_FONT =
  'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif';

export interface RenderPalette {
  accent: string;
  fg: string;
  bg: string;
  headingFont: string;
  bodyFont: string;
  logoUrl: string | null;
}

/**
 * What to actually draw with.
 *
 * Resolution is per-slot rather than all-or-nothing: a repository that stated
 * a brand colour but no background gets its colour on a neutral ground, which
 * is far closer to right than discarding the one fact it did give us. Contrast
 * is checked at the end, because a brand's own foreground and background are
 * not necessarily the pair used on a full-bleed social card — the product may
 * only ever put them together with a container between them.
 */
export function paletteFor(brand: Pick<
  BrandProfile,
  'primary_color' | 'secondary_color' | 'accent_color' | 'background_color' | 'text_color' | 'heading_font' | 'body_font' | 'logo_url'
> | null | undefined): RenderPalette {
  const accent = firstHex(brand?.primary_color, brand?.accent_color, brand?.secondary_color)
    ?? NEUTRAL_PALETTE.accent;
  const bg = firstHex(brand?.background_color) ?? NEUTRAL_PALETTE.bg;
  let fg = firstHex(brand?.text_color) ?? readableOn(bg);

  // A stated pair that cannot be read on a card is worse than no pair at all:
  // the post still publishes, and nobody can read the hook.
  if (contrastRatio(fg, bg) < 4.5) fg = readableOn(bg);

  return {
    accent,
    fg,
    bg,
    headingFont: brand?.heading_font?.trim() || brand?.body_font?.trim() || NEUTRAL_FONT,
    bodyFont: brand?.body_font?.trim() || brand?.heading_font?.trim() || NEUTRAL_FONT,
    logoUrl: brand?.logo_url?.trim() || null,
  };
}

function firstHex(...values: (string | null | undefined)[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim())) return v.trim().toLowerCase();
  }
  return null;
}

/** Relative luminance, per WCAG 2.x. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Near-black or near-white, whichever can actually be read on `bg`. */
export function readableOn(bg: string): string {
  return luminance(bg) > 0.4 ? '#111111' : '#FFFFFF';
}

/* ── Reading the identity back off an analysis ──────────────────────────── */

/**
 * The identity discovered when this analysis ran.
 *
 * Stored on the analysis rather than fetched again because it is a fact about
 * that commit: the same commit has the same colours, so re-reading GitHub to
 * learn them twice is a round trip that can only produce the same answer or
 * fail. An analysis from before discovery existed simply has none, which is
 * handled the same way as a repository that stated nothing.
 */
export function identityFrom(analysis: ProductAnalysis | null | undefined): BrandIdentity | null {
  const raw = analysis?.raw_signals?.brand_identity;
  if (!raw || typeof raw !== 'object') return null;
  const identity = raw as BrandIdentity;
  if (!identity.evidence) return null;
  return identity;
}

/* ── Building the stored patch ──────────────────────────────────────────── */

const IDENTITY_FIELDS = [
  ['brand_name', 'brand_name'],
  ['primary_color', 'primary_color'],
  ['secondary_color', 'secondary_color'],
  ['accent_color', 'accent_color'],
  ['background_color', 'background_color'],
  ['text_color', 'text_color'],
  ['heading_font', 'heading_font'],
  ['body_font', 'body_font'],
  ['logo_url', 'logo_url'],
  ['logo_dark_url', 'logo_dark_url'],
] as const;

export interface IdentityPatch {
  patch: Record<string, unknown>;
  sources: Record<string, string>;
  /** Discovered fields skipped because a human had already corrected them. */
  respected: BrandEditableField[];
}

/**
 * The columns a discovery should write, minus anything a human owns.
 *
 * Returns only fields that were actually found. A field the repository did not
 * answer is left out entirely rather than written as an empty string, so a
 * value discovered by an earlier analysis is not erased by a later one that
 * happened to read a truncated tree.
 */
export function identityPatch(
  identity: BrandIdentity | null,
  existing: Pick<BrandProfile, 'locked_fields'> | null,
): IdentityPatch {
  const locked = new Set<string>(existing?.locked_fields ?? []);
  const patch: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  const respected: BrandEditableField[] = [];

  if (!identity) return { patch, sources, respected };

  for (const [field, key] of IDENTITY_FIELDS) {
    const found = (identity as unknown as Record<string, Discovered<string> | undefined>)[key];
    if (!found?.value) continue;
    if (locked.has(field)) {
      respected.push(field);
      continue;
    }
    patch[field] = found.value;
    sources[field] = found.source;
  }

  if (Object.keys(patch).length > 0) {
    patch.identity_discovered_at = nowIso();
  }

  return { patch, sources, respected };
}

/**
 * Merges a patch over a profile without letting a locked field move.
 *
 * The lock check is repeated here rather than trusted from the caller: this is
 * the last point before a write, every path to a brand profile goes through
 * it, and a lock that holds only when the caller remembers to ask is not a
 * lock.
 */
export function applyRespectingLocks<T extends Record<string, unknown>>(
  existing: Pick<BrandProfile, 'locked_fields'> | null,
  patch: T,
): Partial<T> {
  const locked = new Set<string>(existing?.locked_fields ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (locked.has(k)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/** Records that a human has taken ownership of these fields. */
export function lockFields(
  existing: Pick<BrandProfile, 'locked_fields'> | null,
  edited: string[],
): BrandEditableField[] {
  const allowed = new Set<string>(BRAND_EDITABLE_FIELDS);
  const next = new Set<string>(existing?.locked_fields ?? []);
  for (const field of edited) {
    if (allowed.has(field)) next.add(field);
  }
  return [...next] as BrandEditableField[];
}

/**
 * What the founder should be told about a profile before it drives anything.
 *
 * A brand profile that silently has no colours produces neutral cards that
 * look intentional. Naming the gaps is what makes the difference between a
 * design decision and an undetected failure.
 */
export function identityGaps(brand: BrandProfile | null): string[] {
  if (!brand) return ['No brand profile yet'];
  const gaps: string[] = [];
  if (!brand.primary_color) gaps.push('No brand colour was found in the repository');
  if (!brand.heading_font && !brand.body_font) gaps.push('No typeface was found in the repository');
  if (!brand.logo_url) gaps.push('No logo was found in the repository');
  return gaps;
}

export function logIdentityOutcome(projectId: string, result: IdentityPatch): void {
  log.info('brand identity applied', {
    project: projectId,
    fields: Object.keys(result.patch).filter((k) => k !== 'identity_discovered_at'),
    respectedOverrides: result.respected,
  });
}
