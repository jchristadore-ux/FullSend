/**
 * Platform registry.
 *
 * One place that knows which adapter serves which platform, and which platforms
 * are genuinely live versus architecturally supported but not yet built. The UI
 * reads `platformStatus()` so "coming soon" is only ever shown for something
 * that truly is.
 */
import 'server-only';
import { env } from '../env';
import { FullSendError } from '../errors';
import { LIVE_PLATFORMS, type Platform } from '../types';
import { InstagramAdapter } from './instagram';
import { MockAdapter } from './mock';
import { TikTokAdapter } from './tiktok';
import type { PlatformAdapter } from './types';

const instagram = new InstagramAdapter();
const tiktok = new TikTokAdapter();

/** Test-only override, installed by the suite. */
let mockRegistry: Map<Platform, MockAdapter> | null = null;

export function installMockAdapters(): Map<Platform, MockAdapter> {
  mockRegistry = new Map([
    ['instagram', new MockAdapter('instagram')],
    ['tiktok', new MockAdapter('tiktok', {
      directPublish: true,
      nativeScheduling: false,
      postAnalytics: true,
      accountAnalytics: true,
      supportedFormats: ['short_video'],
      requiresPublicMediaUrl: true,
      dailyPostLimit: null,
      restrictions: [],
    })],
  ]);
  return mockRegistry;
}

export function clearMockAdapters(): void {
  mockRegistry = null;
}

export function getAdapter(platform: Platform): PlatformAdapter {
  if (mockRegistry) {
    const mock = mockRegistry.get(platform);
    if (mock) return mock;
  }
  switch (platform) {
    case 'instagram':
      return instagram;
    case 'tiktok':
      return tiktok;
    default:
      throw new FullSendError(
        'platform_unsupported',
        `${platform} publishing is not built yet`,
        {
          status: 400,
          remedy:
            'Instagram and TikTok are live today. The adapter interface is ready for the others — ' +
            'they are not offered in the UI until they actually work.',
        },
      );
  }
}

export interface PlatformStatus {
  platform: Platform;
  /** An adapter exists and the platform can be published to. */
  live: boolean;
  /** App credentials are present in this deployment. */
  configured: boolean;
  /** Everything works end-to-end, including any required platform approval. */
  fullyOperational: boolean;
  restrictions: string[];
  setupHref: string | null;
}

export function platformStatus(): PlatformStatus[] {
  // Read through getAdapter so an installed mock reports its own state.
  const ig = getAdapter('instagram');
  const tt = getAdapter('tiktok');

  return [
    {
      platform: 'instagram' as Platform,
      live: true,
      configured: ig.configured,
      fullyOperational: ig.configured,
      restrictions: ig.capabilities.restrictions,
      setupHref: '/app/accounts/instagram/setup',
    },
    {
      platform: 'tiktok' as Platform,
      live: true,
      configured: tt.configured,
      // Without the audit, posts are SELF_ONLY — that is not fully operational.
      fullyOperational: tt.configured && (mockRegistry !== null || env.tiktok.audited),
      restrictions: tt.capabilities.restrictions,
      setupHref: '/app/accounts/tiktok/setup',
    },
    ...(['youtube_shorts', 'linkedin', 'facebook', 'x', 'pinterest'] as Platform[]).map((p) => ({
      platform: p,
      live: false,
      configured: false,
      fullyOperational: false,
      restrictions: ['Adapter interface is in place; the integration is not built yet'],
      setupHref: null,
    })),
  ];
}

export function livePlatforms(): Platform[] {
  return LIVE_PLATFORMS;
}

/** Platforms this deployment can publish to right now. */
export function operationalPlatforms(): Platform[] {
  return platformStatus()
    .filter((s) => s.live && s.configured)
    .map((s) => s.platform);
}
