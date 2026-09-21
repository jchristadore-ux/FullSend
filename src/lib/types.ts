/**
 * FullSend domain model.
 *
 * Client- and server-safe: types only, no runtime imports of server modules.
 */

export type Uuid = string;
export type IsoDate = string;

/* ── Platforms ──────────────────────────────────────────────────────────── */

export const PLATFORMS = [
  'instagram',
  'tiktok',
  'youtube_shorts',
  'linkedin',
  'facebook',
  'x',
  'pinterest',
] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * Production social destinations.
 *
 * Instagram is the only production destination. TikTok exists in the codebase
 * but stays off unless FULLSEND_TIKTOK_ENABLED=true — see
 * `livePlatforms()` in `src/lib/social/registry.ts` for the flag-aware list.
 */
export const LIVE_PLATFORMS: Platform[] = ['instagram'];
