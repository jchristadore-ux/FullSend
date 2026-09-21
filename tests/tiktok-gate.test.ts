/**
 * TikTok master gate: off by default so Instagram is the only production
 * destination. Credentials alone must not make TikTok look live.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capabilities, env } from '@/lib/env';
import { FullSendError } from '@/lib/errors';
import { LIVE_PLATFORMS } from '@/lib/types';
import {
  assertPlatformLive,
  clearMockAdapters,
  livePlatforms,
  platformStatus,
} from '@/lib/social/registry';
import { TikTokAdapter } from '@/lib/social/tiktok';

const ORIGINAL_ENABLED = process.env.FULLSEND_TIKTOK_ENABLED;
const ORIGINAL_KEY = process.env.TIKTOK_CLIENT_KEY;
const ORIGINAL_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const ORIGINAL_AUDITED = process.env.TIKTOK_CLIENT_AUDITED;

function restoreEnv(): void {
  if (ORIGINAL_ENABLED === undefined) delete process.env.FULLSEND_TIKTOK_ENABLED;
  else process.env.FULLSEND_TIKTOK_ENABLED = ORIGINAL_ENABLED;
  if (ORIGINAL_KEY === undefined) delete process.env.TIKTOK_CLIENT_KEY;
  else process.env.TIKTOK_CLIENT_KEY = ORIGINAL_KEY;
  if (ORIGINAL_SECRET === undefined) delete process.env.TIKTOK_CLIENT_SECRET;
  else process.env.TIKTOK_CLIENT_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_AUDITED === undefined) delete process.env.TIKTOK_CLIENT_AUDITED;
  else process.env.TIKTOK_CLIENT_AUDITED = ORIGINAL_AUDITED;
}

describe('TikTok gate (FULLSEND_TIKTOK_ENABLED)', () => {
  beforeEach(() => {
    clearMockAdapters();
    delete process.env.FULLSEND_TIKTOK_ENABLED;
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
    delete process.env.TIKTOK_CLIENT_AUDITED;
  });

  afterEach(() => {
    clearMockAdapters();
    restoreEnv();
  });

  it('defaults off: Instagram is the only LIVE_PLATFORMS entry', () => {
    expect(LIVE_PLATFORMS).toEqual(['instagram']);
    expect(env.tiktok.enabled).toBe(false);
  });

  it('capabilities report tiktokEnabled false and tiktok false even with credentials', () => {
    process.env.TIKTOK_CLIENT_KEY = 'key';
    process.env.TIKTOK_CLIENT_SECRET = 'secret';
    const caps = capabilities();
    expect(caps.tiktokEnabled).toBe(false);
    expect(caps.tiktok).toBe(false);
    expect(caps.tiktokPublicPosting).toBe(false);
  });

  it('platformStatus marks TikTok not live with not-available restrictions', () => {
    process.env.TIKTOK_CLIENT_KEY = 'key';
    process.env.TIKTOK_CLIENT_SECRET = 'secret';
    const tt = platformStatus().find((s) => s.platform === 'tiktok');
    expect(tt).toBeDefined();
    expect(tt!.live).toBe(false);
    expect(tt!.configured).toBe(false);
    expect(tt!.fullyOperational).toBe(false);
    expect(tt!.setupHref).toBeNull();
    expect(tt!.restrictions.some((r) => /not available/i.test(r))).toBe(true);
    expect(livePlatforms()).toEqual(['instagram']);
  });

  it('assertPlatformLive refuses TikTok when the gate is off', () => {
    expect(() => assertPlatformLive('tiktok')).toThrow(FullSendError);
    try {
      assertPlatformLive('tiktok');
    } catch (err) {
      expect(err).toBeInstanceOf(FullSendError);
      expect((err as FullSendError).code).toBe('platform_unavailable');
    }
    expect(() => assertPlatformLive('instagram')).not.toThrow();
  });

  it('TikTokAdapter refuses authorize when gated off', () => {
    process.env.TIKTOK_CLIENT_KEY = 'key';
    process.env.TIKTOK_CLIENT_SECRET = 'secret';
    const adapter = new TikTokAdapter();
    expect(adapter.configured).toBe(true);
    expect(() => adapter.authorizeUrl('state', 'https://fullsend.test/callback')).toThrow(
      /not available/i,
    );
  });

  it('enabling FULLSEND_TIKTOK_ENABLED turns TikTok live when credentials exist', () => {
    process.env.FULLSEND_TIKTOK_ENABLED = 'true';
    process.env.TIKTOK_CLIENT_KEY = 'key';
    process.env.TIKTOK_CLIENT_SECRET = 'secret';
    expect(env.tiktok.enabled).toBe(true);
    const caps = capabilities();
    expect(caps.tiktokEnabled).toBe(true);
    expect(caps.tiktok).toBe(true);
    const tt = platformStatus().find((s) => s.platform === 'tiktok');
    expect(tt!.live).toBe(true);
    expect(tt!.configured).toBe(true);
    expect(livePlatforms()).toEqual(['instagram', 'tiktok']);
    expect(() => assertPlatformLive('tiktok')).not.toThrow();
  });
});
