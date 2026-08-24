/**
 * TikTok adapter — Content Posting API v2.
 *
 * The real flow:
 *   1. POST /v2/post/publish/creator_info/query/  → privacy options + limits
 *   2. POST /v2/post/publish/video/init/          → returns publish_id
 *      (PULL_FROM_URL, so TikTok fetches the file from a URL we host)
 *   3. POST /v2/post/publish/status/fetch/        → poll to PUBLISH_COMPLETE
 *
 * Two rules TikTok enforces that shape this adapter:
 *   - `video.publish` (direct post) requires the app to pass TikTok's audit.
 *     Before that, every post is forced to SELF_ONLY. The adapter refuses to
 *     claim otherwise: if the client is unaudited it publishes SELF_ONLY and
 *     says so, rather than silently posting something nobody can see.
 *   - PULL_FROM_URL requires the URL prefix to be verified in the developer
 *     portal. The setup wizard covers this.
 */
import 'server-only';
import { createPkcePair } from '../crypto';
import { env } from '../env';
import { connectionError, FullSendError } from '../errors';
import { logger } from '../logger';
import type { PostMetrics } from '../types';
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

const log = logger('tiktok');

export const TIKTOK_SCOPES = [
  'user.info.basic',
  'user.info.profile',
  'user.info.stats',
  'video.list',
  'video.publish',
];

const STATUS_POLL_ATTEMPTS = 40;
const STATUS_POLL_INTERVAL_MS = 5000;

export class TikTokAdapter implements PlatformAdapter {
  readonly platform = 'tiktok' as const;

  get capabilities(): PlatformCapabilities {
    return {
      directPublish: true,
      nativeScheduling: false,
      postAnalytics: true,
      accountAnalytics: true,
      supportedFormats: ['short_video'],
      requiresPublicMediaUrl: true,
      dailyPostLimit: null,
      restrictions: env.tiktok.audited
        ? ['Video must be reachable at a verified URL prefix (PULL_FROM_URL)']
        : [
            'This client has not passed TikTok audit — every post is forced to SELF_ONLY ' +
              '(visible only to the connected creator)',
            'Submit the app for audit in the TikTok developer portal to publish publicly',
            'Video must be reachable at a verified URL prefix (PULL_FROM_URL)',
          ],
    };
  }

  get configured(): boolean {
    return Boolean(env.tiktok.clientKey && env.tiktok.clientSecret);
  }

  /* ── OAuth (PKCE required) ────────────────────────────────────────────── */

  authorizeUrl(state: string, redirectUri: string): OAuthStartResult {
    this.assertConfigured();
    const { verifier, challenge } = createPkcePair();
    const p = new URLSearchParams({
      client_key: env.tiktok.clientKey!,
      response_type: 'code',
      scope: TIKTOK_SCOPES.join(','),
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return { url: `${env.tiktok.authHost}/v2/auth/authorize/?${p}`, codeVerifier: verifier };
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
  ): Promise<TokenSet> {
    this.assertConfigured();
    if (!codeVerifier) {
      throw new FullSendError('oauth_state_lost', 'The TikTok sign-in session was lost', {
        remedy: 'Start the TikTok connection again.',
      });
    }
    const r = await this.form<any>(`${env.tiktok.apiHost}/v2/oauth/token/`, {
      client_key: env.tiktok.clientKey!,
      client_secret: env.tiktok.clientSecret!,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    return this.toTokenSet(r);
  }

  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) {
      throw connectionError(
        'tiktok',
        'Your TikTok connection expired and cannot be refreshed',
        'Reconnect TikTok in FullSend → Accounts.',
      );
    }
    const r = await this.form<any>(`${env.tiktok.apiHost}/v2/oauth/token/`, {
      client_key: env.tiktok.clientKey!,
      client_secret: env.tiktok.clientSecret!,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    });
    return this.toTokenSet(r);
  }

  private toTokenSet(r: any): TokenSet {
    if (r.error) {
      throw new FullSendError('oauth_failed', `TikTok rejected the token request: ${r.error_description ?? r.error}`, {
        remedy: 'Check TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET, then reconnect.',
      });
    }
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token ?? null,
      expiresAt: new Date(Date.now() + (r.expires_in ?? 86_400) * 1000),
      refreshExpiresAt: r.refresh_expires_in
        ? new Date(Date.now() + r.refresh_expires_in * 1000)
        : null,
      scopes: String(r.scope ?? '').split(',').filter(Boolean),
    };
  }

  /* ── Account ──────────────────────────────────────────────────────────── */

  async getAccount(tokens: TokenSet): Promise<AccountInfo> {
    const fields = 'open_id,union_id,display_name,avatar_url,follower_count,username';
    const r = await this.get<any>(
      `${env.tiktok.apiHost}/v2/user/info/?fields=${fields}`,
      tokens.accessToken,
    );
    const user = r.data?.user ?? {};

    // creator_info tells us which privacy levels this creator actually has.
    let creatorInfo: any = null;
    try {
      creatorInfo = await this.post<any>(
        `${env.tiktok.apiHost}/v2/post/publish/creator_info/query/`,
        tokens.accessToken,
        {},
      );
    } catch (e) {
      log.warn('creator_info unavailable at connect time', { error: String(e) });
    }

    const info = creatorInfo?.data ?? {};
    return {
      externalId: String(user.open_id ?? ''),
      username: user.username ?? user.display_name ?? '',
      displayName: user.display_name ?? null,
      avatarUrl: user.avatar_url ?? null,
      followers: user.follower_count ?? 0,
      metadata: {
        union_id: user.union_id ?? null,
        privacy_level_options: info.privacy_level_options ?? [],
        max_video_post_duration_sec: info.max_video_post_duration_sec ?? null,
        comment_disabled: info.comment_disabled ?? false,
        duet_disabled: info.duet_disabled ?? false,
        stitch_disabled: info.stitch_disabled ?? false,
        client_audited: env.tiktok.audited,
      },
    };
  }

  /* ── Publishing ───────────────────────────────────────────────────────── */

  async publish(
    tokens: TokenSet,
    account: AccountInfo,
    input: PublishInput,
  ): Promise<PublishResult> {
    const videoUrl = input.videoUrl ?? input.mediaUrls[0];
    if (!videoUrl) {
      throw new FullSendError('media_missing', 'TikTok needs a video file to publish', {
        remedy:
          'This post has a production package but no rendered video. Configure a video render ' +
          'provider, or upload the finished video to this post.',
      });
    }

    // Always re-query: privacy options and limits change per creator, per day.
    const creator = await this.post<any>(
      `${env.tiktok.apiHost}/v2/post/publish/creator_info/query/`,
      tokens.accessToken,
      {},
    );
    const info = creator.data ?? {};
    const options: string[] = info.privacy_level_options ?? [];

    const privacyLevel = this.choosePrivacy(input.privacyLevel, options);
    const maxDuration = info.max_video_post_duration_sec;

    const init = await this.post<any>(
      `${env.tiktok.apiHost}/v2/post/publish/video/init/`,
      tokens.accessToken,
      {
        post_info: {
          title: input.caption.slice(0, 2200),
          privacy_level: privacyLevel,
          disable_comment: input.disableComments ?? Boolean(info.comment_disabled),
          disable_duet: input.disableDuet ?? Boolean(info.duet_disabled),
          disable_stitch: input.disableStitch ?? Boolean(info.stitch_disabled),
          video_cover_timestamp_ms: 1000,
        },
        source_info: { source: 'PULL_FROM_URL', video_url: videoUrl },
      },
    );

    const publishId = init.data?.publish_id;
    if (!publishId) {
      throw new FullSendError('publish_failed', 'TikTok did not return a publish id', {
        retryable: true,
        meta: { response: init },
      });
    }

    const status = await this.waitForPublish(publishId, tokens.accessToken);

    const restricted = privacyLevel === 'SELF_ONLY';
    log.info('published to tiktok', { publishId, privacyLevel, restricted, maxDuration });

    return {
      externalId: String(status.publicaly_available_post_id?.[0] ?? publishId),
      permalink: account.username
        ? `https://www.tiktok.com/@${account.username}`
        : null,
      raw: {
        ...status,
        publish_id: publishId,
        privacy_level: privacyLevel,
        // Recorded so the UI can be explicit about a restricted post.
        visibility_restricted: restricted,
        restriction_reason: restricted
          ? env.tiktok.audited
            ? 'Privacy level chosen for this post'
            : 'Client has not passed TikTok audit — posts are forced to SELF_ONLY'
          : null,
      },
    };
  }

  /**
   * An unaudited client can only post SELF_ONLY. Rather than sending a public
   * level TikTok will silently downgrade, pick honestly and record it.
   */
  private choosePrivacy(requested: string | undefined, options: string[]): string {
    if (!env.tiktok.audited) return 'SELF_ONLY';
    if (requested && options.includes(requested)) return requested;
    for (const preferred of ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR']) {
      if (options.includes(preferred)) return preferred;
    }
    return options[0] ?? 'SELF_ONLY';
  }

  private async waitForPublish(publishId: string, token: string): Promise<any> {
    for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt++) {
      const r = await this.post<any>(
        `${env.tiktok.apiHost}/v2/post/publish/status/fetch/`,
        token,
        { publish_id: publishId },
      );
      const data = r.data ?? {};
      const status = data.status;

      if (status === 'PUBLISH_COMPLETE') return data;
      if (status === 'FAILED') {
        throw new FullSendError(
          'publish_failed',
          `TikTok rejected the video: ${data.fail_reason ?? 'unknown reason'}`,
          {
            remedy: mapTikTokFailReason(String(data.fail_reason ?? '')),
            meta: { publishId, failReason: data.fail_reason },
          },
        );
      }
      await sleep(STATUS_POLL_INTERVAL_MS);
    }
    throw new FullSendError('publish_timeout', 'TikTok is still processing the video', {
      retryable: true,
      remedy: 'FullSend will check again shortly.',
      meta: { publishId },
    });
  }

  /* ── Analytics ────────────────────────────────────────────────────────── */

  async getPostMetrics(
    tokens: TokenSet,
    _account: AccountInfo,
    externalId: string,
  ): Promise<Partial<PostMetrics>> {
    try {
      const r = await this.post<any>(
        `${env.tiktok.apiHost}/v2/video/query/?fields=` +
          'id,like_count,comment_count,share_count,view_count,title',
        tokens.accessToken,
        { filters: { video_ids: [externalId] } },
      );
      const video = r.data?.videos?.[0];
      if (!video) return {};
      const out = emptyMetrics();
      out.views = video.view_count ?? 0;
      out.reach = video.view_count ?? 0;
      out.impressions = video.view_count ?? 0;
      out.likes = video.like_count ?? 0;
      out.comments = video.comment_count ?? 0;
      out.shares = video.share_count ?? 0;
      return out;
    } catch (e) {
      log.warn('tiktok video query failed', { externalId, error: String(e) });
      return {};
    }
  }

  async getAccountMetrics(tokens: TokenSet): Promise<Partial<PostMetrics>> {
    try {
      const r = await this.get<any>(
        `${env.tiktok.apiHost}/v2/user/info/?fields=follower_count,likes_count,video_count`,
        tokens.accessToken,
      );
      const user = r.data?.user ?? {};
      return { follows: user.follower_count ?? 0, likes: user.likes_count ?? 0 };
    } catch {
      return {};
    }
  }

  /* ── Plumbing ─────────────────────────────────────────────────────────── */

  private assertConfigured(): void {
    if (!this.configured) {
      throw new FullSendError('platform_not_configured', 'TikTok is not configured', {
        remedy:
          'Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET, then complete the TikTok setup wizard ' +
          'in FullSend → Accounts.',
      });
    }
  }

  private async form<T>(url: string, body: Record<string, string>): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: new URLSearchParams(body),
    });
    return this.handle<T>(res);
  }

  private async get<T>(url: string, token: string): Promise<T> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    return this.handle<T>(res);
  }

  private async post<T>(url: string, token: string, body: unknown): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(body),
    });
    return this.handle<T>(res);
  }

  private async handle<T>(res: Response): Promise<T> {
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    const err = body.error;
    // TikTok returns 200 with error.code "ok" on success.
    if (!res.ok || (err && err.code && err.code !== 'ok')) {
      throw mapTikTokError(err ?? { code: `http_${res.status}` }, res.status);
    }
    return body as T;
  }
}

export function mapTikTokError(
  error: { code?: string; message?: string; log_id?: string },
  status = 400,
): FullSendError {
  const code = error.code ?? '';
  const message = error.message ?? 'TikTok request failed';

  if (code === 'access_token_invalid' || code === 'access_token_expired' || status === 401) {
    return connectionError(
      'tiktok',
      'Your TikTok connection expired',
      'Reconnect TikTok in FullSend → Accounts. Publishing resumes automatically once you do.',
    );
  }
  if (code === 'scope_not_authorized' || code === 'scope_permission_missed') {
    return connectionError(
      'tiktok',
      'TikTok has not granted the publishing permission',
      'The video.publish scope is missing. Reconnect and accept the publishing permission, and ' +
        'confirm the scope is enabled for your app in the TikTok developer portal.',
    );
  }
  if (code === 'rate_limit_exceeded' || status === 429) {
    return new FullSendError('rate_limited', 'TikTok rate limit reached', {
      status: 429,
      retryable: true,
      remedy: 'FullSend will retry this publish shortly.',
    });
  }
  if (code === 'url_ownership_unverified') {
    return new FullSendError('media_url_unverified', 'TikTok will not fetch from this URL', {
      remedy:
        'Verify your media domain in the TikTok developer portal under URL Prefix Verification, ' +
        'then retry. This is a one-time setup step.',
    });
  }
  if (code === 'spam_risk_too_many_posts' || code === 'spam_risk_user_banned_from_posting') {
    return new FullSendError('platform_restricted', `TikTok is throttling posts: ${code}`, {
      retryable: true,
      remedy: 'TikTok limits how often an account can post via API. FullSend will space these out.',
    });
  }
  return new FullSendError('platform_error', `TikTok error: ${message} (${code})`, {
    retryable: status >= 500,
    meta: { code, logId: error.log_id },
  });
}

function mapTikTokFailReason(reason: string): string {
  if (/duration/i.test(reason)) return 'The video is longer than this creator can post. Shorten it.';
  if (/format|codec/i.test(reason)) return 'Re-encode the video as MP4 / H.264 and retry.';
  if (/download|url/i.test(reason))
    return 'TikTok could not fetch the video. Confirm the URL is public and the domain is verified.';
  if (/size/i.test(reason)) return 'The file is too large. Compress it and retry.';
  return 'Check the video against TikTok’s requirements, then retry.';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
