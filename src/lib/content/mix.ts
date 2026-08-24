/**
 * Content-mix planning.
 *
 * Turns "40% education, 25% demo…" plus a cadence into a concrete list of slots
 * — which pillar, which platform, which format, on which day at which hour.
 * The calendar and the generator both consume this, so a mix change propagates
 * to real posts rather than being a number on a dashboard.
 */

import type {
  ContentFormat,
  ContentMix,
  MarketingStrategy,
  PillarType,
  Platform,
} from '../types';

export interface Slot {
  platform: Platform;
  format: ContentFormat;
  pillarType: PillarType;
  /** UTC instant this slot should publish at. */
  at: Date;
}

/** Formats each platform actually supports for publishing today. */
export const PLATFORM_FORMATS: Record<Platform, ContentFormat[]> = {
  instagram: ['reel', 'carousel', 'static', 'story'],
  tiktok: ['short_video'],
  youtube_shorts: ['short_video'],
  linkedin: ['static', 'text'],
  facebook: ['static', 'reel'],
  x: ['text', 'static'],
  pinterest: ['static'],
};

/** Which format best carries which pillar, in preference order. */
const PILLAR_FORMAT_PREFERENCE: Record<PillarType, ContentFormat[]> = {
  education: ['carousel', 'reel', 'short_video', 'static'],
  product_demo: ['reel', 'short_video', 'carousel', 'static'],
  entertainment: ['reel', 'short_video', 'story'],
  social_proof: ['carousel', 'static', 'reel', 'short_video'],
  promotion: ['reel', 'static', 'short_video', 'carousel'],
};

export function formatFor(platform: Platform, pillar: PillarType, seed: number): ContentFormat {
  const supported = PLATFORM_FORMATS[platform] ?? ['static'];
  const preferred = PILLAR_FORMAT_PREFERENCE[pillar].filter((f) => supported.includes(f));
  if (preferred.length === 0) return supported[0];
  // Rotate through preferences so a pillar doesn't become one format forever.
  return preferred[seed % preferred.length];
}

/**
 * Largest-remainder allocation. Guarantees the counts sum exactly to `total`
 * and that a non-zero share always gets at least one slot.
 */
export function allocate(mix: ContentMix, total: number): Record<PillarType, number> {
  const keys = Object.keys(mix) as PillarType[];
  const exact = keys.map((k) => ({ k, v: (mix[k] / 100) * total }));
  const base = exact.map((e) => ({ ...e, floor: Math.floor(e.v), rem: e.v - Math.floor(e.v) }));
  let assigned = base.reduce((s, b) => s + b.floor, 0);
  const out = Object.fromEntries(base.map((b) => [b.k, b.floor])) as Record<PillarType, number>;

  const byRemainder = [...base].sort((a, b) => b.rem - a.rem);
  let i = 0;
  while (assigned < total && byRemainder.length) {
    const target = byRemainder[i % byRemainder.length];
    out[target.k] += 1;
    assigned += 1;
    i += 1;
  }

  // A pillar the strategy asked for should never be silently dropped.
  if (total >= keys.filter((k) => mix[k] > 0).length) {
    for (const k of keys) {
      if (mix[k] > 0 && out[k] === 0) {
        const donor = keys.reduce((a, b) => (out[b] > out[a] ? b : a));
        if (out[donor] > 1) {
          out[donor] -= 1;
          out[k] += 1;
        }
      }
    }
  }
  return out;
}

export interface PlanOptions {
  days: number;
  /** Start of the planning window. Slots are always in the future. */
  from: Date;
  strategy: Pick<MarketingStrategy, 'content_mix' | 'posting_cadence' | 'platform_strategy'>;
  platforms: Platform[];
  /** Hard ceiling per day, from project settings. */
  dailyCap: number;
  quietHours?: { start: number; end: number } | null;
}

/**
 * Builds the slot plan for a window. Deterministic given the same inputs, which
 * is what makes the calendar reproducible and testable.
 */
export function planSlots(opts: PlanOptions): Slot[] {
  const { days, from, strategy, platforms, dailyCap, quietHours } = opts;
  const weeks = days / 7;

  const perPlatformPerWeek: Record<string, number> = {
    instagram: strategy.posting_cadence?.instagram_per_week ?? 4,
    tiktok: strategy.posting_cadence?.tiktok_per_week ?? 5,
  };

  const slots: Slot[] = [];
  const perDay = new Map<string, number>();

  for (const platform of platforms) {
    const perWeek = perPlatformPerWeek[platform] ?? 3;
    const total = Math.max(0, Math.round(perWeek * weeks));
    if (total === 0) continue;

    const allocation = allocate(strategy.content_mix, total);
    const queue: PillarType[] = [];
    // Interleave pillars rather than posting five demos in a row.
    const entries = (Object.entries(allocation) as [PillarType, number][]).filter(([, n]) => n > 0);
    let remaining = total;
    let round = 0;
    while (remaining > 0 && entries.length) {
      for (const entry of entries) {
        if (entry[1] > 0 && remaining > 0) {
          queue.push(entry[0]);
          entry[1] -= 1;
          remaining -= 1;
        }
      }
      round++;
      if (round > total + 5) break;
    }

    const times = (strategy.posting_cadence?.best_times ?? []).filter(
      (t) => t.platform === platform,
    );
    const fallbackTimes = [
      { day: 1, hour: 9 },
      { day: 2, hour: 18 },
      { day: 3, hour: 9 },
      { day: 4, hour: 19 },
      { day: 5, hour: 12 },
      { day: 6, hour: 11 },
      { day: 0, hour: 17 },
    ];
    const schedule = times.length ? times.map((t) => ({ day: t.day, hour: t.hour })) : fallbackTimes;

    for (let i = 0; i < queue.length; i++) {
      const pillar = queue[i];
      const slotTime = schedule[i % schedule.length];
      const at = nextOccurrence(from, slotTime.day, slotTime.hour, Math.floor(i / schedule.length));
      if (at.getTime() > from.getTime() + days * 86_400_000) continue;

      const adjusted = avoidQuietHours(at, quietHours);
      const dayKey = adjusted.toISOString().slice(0, 10);
      if ((perDay.get(dayKey) ?? 0) >= dailyCap) continue;
      perDay.set(dayKey, (perDay.get(dayKey) ?? 0) + 1);

      slots.push({
        platform,
        format: formatFor(platform, pillar, i),
        pillarType: pillar,
        at: adjusted,
      });
    }
  }

  return slots.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The `weekOffset`-th occurrence of `day` at `hour`, strictly after `from`. */
function nextOccurrence(from: Date, day: number, hour: number, weekOffset: number): Date {
  const d = new Date(from);
  d.setUTCHours(hour, 0, 0, 0);
  const delta = (day - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta + weekOffset * 7);
  if (d.getTime() <= from.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}

function avoidQuietHours(at: Date, quiet?: { start: number; end: number } | null): Date {
  if (!quiet) return at;
  const h = at.getUTCHours();
  const inQuiet =
    quiet.start <= quiet.end ? h >= quiet.start && h < quiet.end : h >= quiet.start || h < quiet.end;
  if (!inQuiet) return at;
  const out = new Date(at);
  out.setUTCHours(quiet.end, 0, 0, 0);
  if (out.getTime() <= at.getTime()) out.setUTCDate(out.getUTCDate() + 1);
  return out;
}

/** Applies an optimizer decision to a mix, keeping the total at 100. */
export function shiftMix(
  mix: ContentMix,
  from: PillarType,
  to: PillarType,
  points: number,
): ContentMix {
  const next = { ...mix };
  // Never starve a pillar completely — 5% keeps a format in the experiment pool.
  const movable = Math.max(0, Math.min(points, next[from] - 5));
  next[from] -= movable;
  next[to] += movable;
  return next;
}
