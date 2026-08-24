import type { Platform } from './types';

/** Platforms have their own capitalisation. "Tiktok" is wrong; "TikTok" is not. */
export const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube_shorts: 'YouTube Shorts',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  x: 'X',
  pinterest: 'Pinterest',
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform as Platform] ?? platform;
}
