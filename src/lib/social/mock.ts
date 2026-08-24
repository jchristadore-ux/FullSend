/**
 * Mock platform adapter.
 *
 * Used by the test suite and by the E2E chain, so the whole publish → analytics
 * → optimize loop can be exercised without touching a real account. It models
 * the parts that matter: async processing, quota exhaustion, transient failure,
 * and metric growth over time.
 *
 * This is never selected in production — `getAdapter` only returns it when
 * FULLSEND_SOCIAL_DRIVER=mock, which is set by tests.
 */

import { FullSendError } from '../errors';
import { newId } from '../ids';
import type { Platform, PostMetrics } from '../types';
import { platformLabel } from '../platform-labels';
import {
  emptyMetrics,
  type AccountInfo,
  type OAuthStartResult,
  type PlatformAdapter,
  type PlatformCapabilities,
  type PublishInput,
  type PublishResult,
  type TokenSet,
} from './types';

export interface MockPost {
  externalId: string;
  publishedAt: number;
  input: PublishInput;
  metrics: PostMetrics;
}

export class MockAdapter implements PlatformAdapter {
  readonly configured = true;
  readonly posts = new Map<string, MockPost>();

  /** Test controls. */
  failNextPublish: FullSendError | null = null;
  quotaUsed = 0;
  quotaLimit = 100;
  tokenExpired = false;

  constructor(
    readonly platform: Platform,
    readonly capabilities: PlatformCapabilities = {
      directPublish: true,
      nativeScheduling: false,
      postAnalytics: true,
      accountAnalytics: true,
      supportedFormats: ['reel', 'carousel', 'static', 'story', 'short_video'],
      requiresPublicMediaUrl: true,
      dailyPostLimit: 100,
      restrictions: [],
    },
  ) {}

  authorizeUrl(state: string, redirectUri: string): OAuthStartResult {
    return {
      url: `https://mock.local/oauth?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      codeVerifier: 'mock-verifier',
    };
  }

  async exchangeCode(code: string): Promise<TokenSet> {
    if (code === 'bad-code') {
      throw new FullSendError('oauth_failed', 'Mock rejected the code', { status: 400 });
    }
    return {
      accessToken: `mock-access-${newId()}`,
      refreshToken: `mock-refresh-${newId()}`,
      expiresAt: new Date(Date.now() + 3600_000),
      refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      scopes: ['publish', 'insights'],
    };
  }

  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) {
      throw new FullSendError('connection_error', 'No refresh token', { status: 409 });
    }
    // A revoked connection cannot be refreshed back to life — that is the whole
    // point of the failure mode this models.
    if (this.tokenExpired) {
      throw new FullSendError('connection_error', `${platformLabel(this.platform)} refused the refresh`, {
        status: 409,
        remedy: `Reconnect ${platformLabel(this.platform)}.`,
        meta: { platform: this.platform, needsAttention: true },
      });
    }
    return {
      ...tokens,
      accessToken: `mock-access-${newId()}`,
      expiresAt: new Date(Date.now() + 3600_000),
    };
  }

  async getAccount(): Promise<AccountInfo> {
    return {
      externalId: `mock-${this.platform}-account`,
      username: `mock_${this.platform}`,
      displayName: `Mock ${this.platform}`,
      avatarUrl: null,
      followers: 1200,
      metadata: { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] },
    };
  }

  async publish(
    _tokens: TokenSet,
    _account: AccountInfo,
    input: PublishInput,
  ): Promise<PublishResult> {
    if (this.tokenExpired) {
      throw new FullSendError('connection_error', `Your ${platformLabel(this.platform)} connection expired`, {
        status: 409,
        remedy: `Reconnect ${platformLabel(this.platform)}.`,
        meta: { platform: this.platform, needsAttention: true },
      });
    }
    if (this.failNextPublish) {
      const err = this.failNextPublish;
      this.failNextPublish = null;
      throw err;
    }
    if (this.quotaUsed >= this.quotaLimit) {
      throw new FullSendError('quota_exhausted', `${platformLabel(this.platform)} daily limit reached`, {
        status: 429,
        retryable: true,
        remedy: 'FullSend will publish this tomorrow.',
      });
    }
    if (input.mediaUrls.length === 0 && !input.videoUrl) {
      throw new FullSendError('media_missing', 'No media supplied', { status: 400 });
    }

    this.quotaUsed++;
    const externalId = `mock-post-${newId()}`;
    this.posts.set(externalId, {
      externalId,
      publishedAt: Date.now(),
      input,
      metrics: emptyMetrics(),
    });
    return {
      externalId,
      permalink: `https://mock.local/${this.platform}/${externalId}`,
      raw: { ok: true, id: externalId, platform: this.platform },
    };
  }

  async getPostMetrics(
    _tokens: TokenSet,
    _account: AccountInfo,
    externalId: string,
  ): Promise<Partial<PostMetrics>> {
    const post = this.posts.get(externalId);
    if (!post) return {};
    return post.metrics;
  }

  async getAccountMetrics(): Promise<Partial<PostMetrics>> {
    let reach = 0;
    let follows = 0;
    for (const p of this.posts.values()) {
      reach += p.metrics.reach;
      follows += p.metrics.follows;
    }
    return { reach, follows };
  }

  async getQuota(): Promise<{ used: number; limit: number }> {
    return { used: this.quotaUsed, limit: this.quotaLimit };
  }

  /** Test helper: give a post explicit numbers so the optimizer has signal. */
  setMetrics(externalId: string, metrics: Partial<PostMetrics>): void {
    const post = this.posts.get(externalId);
    if (post) post.metrics = { ...post.metrics, ...metrics };
  }

  reset(): void {
    this.posts.clear();
    this.quotaUsed = 0;
    this.failNextPublish = null;
    this.tokenExpired = false;
  }
}
