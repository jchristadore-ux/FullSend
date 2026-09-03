/**
 * Instagram adapter — Meta's Instagram Platform content publishing API.
 *
 * The real flow, as Meta specifies it:
 *   1. POST /{ig-user-id}/media          → returns a container id
 *   2. GET  /{container-id}?fields=status_code → poll until FINISHED
 *   3. POST /{ig-user-id}/media_publish  → returns the published media id
 *
 * Carousels create one child container per item, then a parent CAROUSEL
 * container. Reels use media_type=REELS, Stories use media_type=STORIES.
 *
 * Requirements Meta enforces, which the setup wizard walks the user through:
 *   - Instagram *Business* account (Creator accounts cannot content-publish)
 *   - linked Facebook Page, and a Meta app with Instagram configured
 *   - `instagram_business_content_publish` approved via App Review
 *   - media hosted at a public URL Meta's servers can fetch
 *   - 100 API-published posts per rolling 24 hours
 */
import 'server-only';
import { env } from '../env';
import { connectionError, FullSendError } from '../errors';
import { logger } from '../logger';
import type { ContentFormat, PostMetrics } from '../types';
import { classifyMetaAuthFailure } from './meta-app';
import {
  INSTAGRAM_SCOPES_FACEBOOK_LOGIN,
  INSTAGRAM_SCOPES_INSTAGRAM_LOGIN,
} from './instagram-scopes';
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

const log = logger('instagram');

export {
  INSTAGRAM_SCOPES_FACEBOOK_LOGIN,
  INSTAGRAM_SCOPES_INSTAGRAM_LOGIN,
} from './instagram-scopes';

/*
 * Meta transcodes asynchronously, and a Reel can take minutes. Waiting it out
 * inside one invocation is what produced a request long enough to be killed —
 * so the wait is bounded here and the *job* resumes the same container on the
 * next pass. Eight attempts is about 25 seconds: long enough that an image
 * finishes in the first attempt, short enough to leave the invocation intact.
 */
const CONTAINER_POLL_ATTEMPTS = 8;
const CONTAINER_POLL_INTERVAL_MS = 3000;
/** How far back to look for a post whose publish response was lost. */
const RECOVERY_LOOKUP_LIMIT = 25;

export class InstagramAdapter implements PlatformAdapter {
  readonly platform = 'instagram' as const;

  readonly capabilities: PlatformCapabilities = {
    directPublish: true,
    // Meta has no scheduling endpoint — FullSend holds the post and fires on time.
    nativeScheduling: false,
    postAnalytics: true,
    accountAnalytics: true,
    supportedFormats: ['reel', 'carousel', 'static', 'story'],
    requiresPublicMediaUrl: true,
    dailyPostLimit: 100,
    restrictions: [
      'Requires an Instagram Business account linked to a Facebook Page',
      'instagram_business_content_publish must be approved through Meta App Review',
      'Media must be reachable at a public HTTPS URL',
      '100 API-published posts per rolling 24 hours',
    ],
  };

  get configured(): boolean {
    return Boolean(env.meta.appId && env.meta.appSecret);
  }

  private get instagramLogin(): boolean {
    return env.meta.loginMode === 'instagram_login';
  }

  private get scopes(): string[] {
    return this.instagramLogin
      ? INSTAGRAM_SCOPES_INSTAGRAM_LOGIN
      : INSTAGRAM_SCOPES_FACEBOOK_LOGIN;
  }

  private graph(path: string): string {
    const host = this.instagramLogin ? env.meta.instagramGraphHost : env.meta.graphHost;
    return `${host}/${env.meta.graphVersion}${path}`;
  }

  /* ── OAuth ────────────────────────────────────────────────────────────── */

  authorizeUrl(state: string, redirectUri: string): OAuthStartResult {
    this.assertConfigured();
    if (this.instagramLogin) {
      const p = new URLSearchParams({
        client_id: env.meta.appId!,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: this.scopes.join(','),
        state,
      });
      return { url: `https://www.instagram.com/oauth/authorize?${p}` };
    }
    const p = new URLSearchParams({
      client_id: env.meta.appId!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.scopes.join(','),
      state,
    });
    return { url: `https://www.facebook.com/${env.meta.graphVersion}/dialog/oauth?${p}` };
  }

  async exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
    this.assertConfigured();

    if (this.instagramLogin) {
      // Instagram Login: form POST, then upgrade the short-lived token.
      const body = new URLSearchParams({
        client_id: env.meta.appId!,
        client_secret: env.meta.appSecret!,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      });
      const short = await this.json<any>('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const long = await this.json<any>(
        `${env.meta.instagramGraphHost}/access_token?` +
          new URLSearchParams({
            grant_type: 'ig_exchange_token',
            client_secret: env.meta.appSecret!,
            access_token: short.access_token,
          }),
      );
      return {
        accessToken: long.access_token,
        refreshToken: null,
        expiresAt: new Date(Date.now() + (long.expires_in ?? 5_184_000) * 1000),
        refreshExpiresAt: null,
        scopes: this.scopes,
      };
    }

    // Facebook Login: short-lived user token, then a long-lived one (~60 days).
    const short = await this.json<any>(
      this.graph('/oauth/access_token') +
        '?' +
        new URLSearchParams({
          client_id: env.meta.appId!,
          client_secret: env.meta.appSecret!,
          redirect_uri: redirectUri,
          code,
        }),
    );
    const long = await this.json<any>(
      this.graph('/oauth/access_token') +
        '?' +
        new URLSearchParams({
          grant_type: 'fb_exchange_token',
          client_id: env.meta.appId!,
          client_secret: env.meta.appSecret!,
          fb_exchange_token: short.access_token,
        }),
    );
    return {
      accessToken: long.access_token,
      refreshToken: null,
      expiresAt: new Date(Date.now() + (long.expires_in ?? 5_184_000) * 1000),
      refreshExpiresAt: null,
      scopes: this.scopes,
    };
  }

  /**
   * Instagram Login tokens refresh in place. Facebook Page tokens derived from
   * a long-lived user token do not expire, so there is nothing to refresh.
   */
  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!this.instagramLogin) return tokens;
    const r = await this.json<any>(
      `${env.meta.instagramGraphHost}/refresh_access_token?` +
        new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: tokens.accessToken }),
    );
    return {
      ...tokens,
      accessToken: r.access_token,
      expiresAt: new Date(Date.now() + (r.expires_in ?? 5_184_000) * 1000),
    };
  }

  /* ── Account ──────────────────────────────────────────────────────────── */

  /**
   * The account this authorization is for.
   *
   * `preferredExternalId` is how a reconnect stays on the same account. Under
   * Facebook Login one person can administer Pages for several brands, and the
   * previous implementation took `pages.data.find(p => p.instagram_business_account)`
   * — the first Page Meta happened to return. Reconnect one brand while
   * holding another brand's Page and it would quietly rebind the project to
   * the wrong Instagram account, with the wrong followers and the wrong feed.
   * A connection that can silently land on a different account is not a
   * connection anybody can rely on, so when there is a choice to make it is
   * made explicitly or not at all.
   */
  async getAccount(tokens: TokenSet, preferredExternalId?: string | null): Promise<AccountInfo> {
    const candidates = await this.listAccounts(tokens);

    if (candidates.length === 0) {
      throw connectionError(
        'instagram',
        'No Instagram Business account is available to this login',
        'In the Instagram app: Settings → Account type and tools → Switch to professional account → ' +
          'Business. Under Facebook Login the account must also be linked to a Page you administer.',
      );
    }

    if (preferredExternalId) {
      const wanted = candidates.find((c) => c.externalId === String(preferredExternalId));
      if (wanted) return wanted;
      throw connectionError(
        'instagram',
        'This login does not manage the Instagram account this project is already connected to',
        `It can reach ${candidates.map((c) => `@${c.username}`).join(', ')}. Sign in as the person ` +
          'who administers the connected account, or disconnect it first if you mean to move this ' +
          'brand to a different account. FullSend will not move it on its own.',
      );
    }

    if (candidates.length === 1) return candidates[0];

    /*
     * Several eligible accounts and nothing to choose between them. Picking
     * one would be a coin toss with somebody's feed, so the caller is handed
     * the list and asked — the Accounts page renders a button per account.
     */
    throw new FullSendError(
      'instagram_account_choice_required',
      'This login can manage more than one Instagram account',
      {
        status: 409,
        retryable: false,
        remedy: 'Choose which Instagram account this brand should publish to.',
        meta: {
          candidates: candidates.map((c) => ({
            externalId: c.externalId,
            username: c.username,
            displayName: c.displayName,
            followers: c.followers,
          })),
        },
      },
    );
  }

  /**
   * Every Instagram Business account this authorization can publish to.
   *
   * One Meta application, many accounts: this is the list that makes that
   * true. Under Instagram Login it is always the one account that authorized;
   * under Facebook Login it is every Page-linked Business account the person
   * administers.
   */
  async listAccounts(tokens: TokenSet): Promise<AccountInfo[]> {
    if (this.instagramLogin) {
      const me = await this.json<any>(
        `${env.meta.instagramGraphHost}/me?` +
          new URLSearchParams({
            fields: 'user_id,username,name,profile_picture_url,followers_count,account_type',
            access_token: tokens.accessToken,
          }),
      );
      this.assertBusinessAccount(me.account_type);
      return [
        {
          externalId: String(me.user_id ?? me.id),
          username: me.username ?? '',
          displayName: me.name ?? null,
          avatarUrl: me.profile_picture_url ?? null,
          followers: me.followers_count ?? 0,
          metadata: { account_type: me.account_type, login_mode: 'instagram_login' },
          platformToken: null,
        },
      ];
    }

    // Facebook Login: every Page, and the Instagram business account on it.
    const pages = await this.json<any>(
      this.graph('/me/accounts') +
        '?' +
        new URLSearchParams({
          fields:
            'id,name,access_token,instagram_business_account{id,username,name,profile_picture_url,followers_count}',
          access_token: tokens.accessToken,
        }),
    );

    return (pages.data ?? [])
      .filter((p: any) => p.instagram_business_account)
      .map((page: any) => {
        const ig = page.instagram_business_account;
        return {
          externalId: String(ig.id),
          username: ig.username ?? '',
          displayName: ig.name ?? page.name ?? null,
          avatarUrl: ig.profile_picture_url ?? null,
          followers: ig.followers_count ?? 0,
          metadata: {
            page_id: page.id,
            page_name: page.name,
            login_mode: 'facebook_login',
          },
          /*
           * The Page token publishing needs — returned as a credential, not
           * folded into `metadata`. It used to live in `platform_metadata`,
           * which the accounts API hands to the browser: a live publishing
           * credential, in a JSON payload, for anyone with the page open. It
           * now goes into the encrypted vault beside the user token.
           */
          platformToken: typeof page.access_token === 'string' ? page.access_token : null,
        } satisfies AccountInfo;
      });
  }

  private assertBusinessAccount(accountType?: string): void {
    if (accountType && accountType !== 'BUSINESS') {
      throw connectionError(
        'instagram',
        `Content publishing needs a Business account; this one is ${accountType}`,
        'In the Instagram app: Settings → Account type and tools → Switch to professional account → Business.',
      );
    }
  }

  /**
   * The credential a publish call is made with.
   *
   * Under Facebook Login that is the Page token, which arrives in the token
   * set. The `platform_metadata` fallback is for accounts connected before the
   * token moved into the vault — they keep working, and are upgraded the next
   * time they reconnect.
   */
  private publishToken(tokens: TokenSet, account: AccountInfo): string {
    if (tokens.platformToken) return tokens.platformToken;
    const legacy = account.metadata?.page_access_token;
    return typeof legacy === 'string' && legacy ? legacy : tokens.accessToken;
  }

  /* ── Publishing ───────────────────────────────────────────────────────── */

  async publish(
    tokens: TokenSet,
    account: AccountInfo,
    input: PublishInput,
  ): Promise<PublishResult> {
    const token = this.publishToken(tokens, account);
    const igId = account.externalId;

    /*
     * A retry resumes the container the previous attempt built rather than
     * uploading the media again. Two containers for one post is how the same
     * content ends up on the account twice.
     */
    let creationId = input.resumeContainerId ?? null;
    if (!creationId) {
      creationId =
        input.format === 'carousel'
          ? await this.createCarousel(igId, token, input)
          : await this.createSingleContainer(igId, token, input);
      await input.onContainer?.(creationId);
    }

    await this.waitForContainer(creationId, token);

    // Recorded before the call, not after: if the response never comes back,
    // this is the only evidence that a publish was ever attempted.
    await input.onSubmit?.(creationId);

    const published = await this.json<any>(this.graph(`/${igId}/media_publish`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ creation_id: creationId, access_token: token }),
    });

    const mediaId = String(published.id);
    const permalink = await this.fetchPermalink(mediaId, token);

    log.info('published to instagram', { mediaId, format: input.format });
    return { externalId: mediaId, permalink, raw: published };
  }

  /**
   * Did the container we submitted actually go live?
   *
   * Meta answers this directly: a container that has been published reports
   * `status_code=PUBLISHED`. The media id is not derivable from the container
   * id, so the post itself is found in the account's recent media by its
   * caption. Anything short of a definite answer throws rather than returning
   * null — "I don't know" must never be read as "it did not publish".
   */
  async findPublished(
    tokens: TokenSet,
    account: AccountInfo,
    attempt: { containerId: string; caption: string },
  ): Promise<PublishResult | null> {
    const token = this.publishToken(tokens, account);
    const status = await this.json<any>(
      this.graph(`/${attempt.containerId}`) +
        '?' +
        new URLSearchParams({ fields: 'status_code,status', access_token: token }),
    );

    if (status.status_code !== 'PUBLISHED') return null;

    const recent = await this.json<any>(
      this.graph(`/${account.externalId}/media`) +
        '?' +
        new URLSearchParams({
          fields: 'id,caption,permalink,timestamp',
          limit: String(RECOVERY_LOOKUP_LIMIT),
          access_token: token,
        }),
    );

    const wanted = normalizeCaption(attempt.caption);
    const match = (recent.data ?? []).find(
      (m: any) => normalizeCaption(String(m.caption ?? '')) === wanted,
    );

    if (!match) {
      // The container says published but the media is not in the recent list.
      // Refusing to guess is the point: throwing keeps the post held for
      // another attempt instead of publishing it a second time.
      throw new FullSendError(
        'publish_unverified',
        'Instagram reports this post as published but it could not be matched to a media id',
        {
          retryable: true,
          remedy:
            'FullSend will check again shortly rather than risk publishing it twice. If it stays ' +
            'unresolved, the post is on your profile — mark it published from the calendar.',
          meta: { containerId: attempt.containerId },
        },
      );
    }

    return {
      externalId: String(match.id),
      permalink: match.permalink ?? null,
      raw: { recovered: true, container_id: attempt.containerId, timestamp: match.timestamp },
    };
  }

  private async createSingleContainer(
    igId: string,
    token: string,
    input: PublishInput,
  ): Promise<string> {
    const params = new URLSearchParams({ caption: input.caption, access_token: token });

    if (input.format === 'reel') {
      const video = input.videoUrl ?? input.mediaUrls[0];
      this.requireMedia(video, 'a video URL', 'Reel');
      params.set('media_type', 'REELS');
      params.set('video_url', video!);
      if (input.coverUrl) params.set('cover_url', input.coverUrl);
      params.set('share_to_feed', String(input.shareToFeed ?? true));
    } else if (input.format === 'story') {
      const media = input.videoUrl ?? input.mediaUrls[0];
      this.requireMedia(media, 'an image or video URL', 'Story');
      params.set('media_type', 'STORIES');
      params.set(input.videoUrl ? 'video_url' : 'image_url', media!);
      // Stories carry no caption.
      params.delete('caption');
    } else {
      const image = input.mediaUrls[0];
      this.requireMedia(image, 'an image URL', 'feed post');
      params.set('image_url', image!);
    }

    const container = await this.json<any>(this.graph(`/${igId}/media`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    return String(container.id);
  }

  private async createCarousel(
    igId: string,
    token: string,
    input: PublishInput,
  ): Promise<string> {
    if (input.mediaUrls.length < 2) {
      throw new FullSendError('media_missing', 'A carousel needs at least two images', {
        remedy: 'FullSend will regenerate the creative for this post.',
      });
    }
    const children: string[] = [];
    for (const url of input.mediaUrls.slice(0, 10)) {
      const child = await this.json<any>(this.graph(`/${igId}/media`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          image_url: url,
          is_carousel_item: 'true',
          access_token: token,
        }),
      });
      children.push(String(child.id));
    }
    const parent = await this.json<any>(this.graph(`/${igId}/media`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        media_type: 'CAROUSEL',
        children: children.join(','),
        caption: input.caption,
        access_token: token,
      }),
    });
    return String(parent.id);
  }

  private requireMedia(url: string | undefined | null, what: string, kind: string): void {
    if (!url) {
      throw new FullSendError('media_missing', `An Instagram ${kind} needs ${what}`, {
        remedy:
          'Media must be at a public HTTPS URL. Configure Supabase Storage so FullSend can host ' +
          'generated creative.',
      });
    }
  }

  /** Meta transcodes asynchronously; publishing before FINISHED fails. */
  private async waitForContainer(containerId: string, token: string): Promise<void> {
    for (let attempt = 0; attempt < CONTAINER_POLL_ATTEMPTS; attempt++) {
      const status = await this.json<any>(
        this.graph(`/${containerId}`) +
          '?' +
          new URLSearchParams({ fields: 'status_code,status', access_token: token }),
      );
      const code = status.status_code;
      if (code === 'FINISHED') return;
      // Already live: a previous attempt published it and lost the response.
      // The caller's recovery path owns this case, so stop rather than publish.
      if (code === 'PUBLISHED') {
        throw new FullSendError('publish_already_submitted', 'This container is already published', {
          retryable: true,
          remedy: 'FullSend will match it to the live post rather than publish it again.',
          meta: { containerId, alreadyPublished: true },
        });
      }
      if (code === 'ERROR') {
        throw new FullSendError('publish_failed', `Instagram rejected the media: ${status.status}`, {
          remedy:
            'Usually a media format problem. Check the video is MP4/H.264 and within the ' +
            'Reels limits, then FullSend will retry.',
          meta: { containerId, status: status.status, containerUnusable: true },
        });
      }
      if (code === 'EXPIRED') {
        throw new FullSendError('publish_failed', 'The media container expired before publishing', {
          retryable: true,
          remedy: 'FullSend will rebuild the container and retry.',
          // An expired container cannot be resumed; the retry starts a new one.
          meta: { containerId, containerUnusable: true },
        });
      }
      await sleep(CONTAINER_POLL_INTERVAL_MS);
    }
    // Not a failure: Meta is still transcoding. The container id is already
    // saved, so the next worker pass picks up this same container rather than
    // uploading the media again.
    throw new FullSendError('publish_pending', 'Instagram is still processing the media', {
      retryable: true,
      remedy: 'FullSend will check again shortly.',
      meta: { containerId, stillProcessing: true },
    });
  }

  private async fetchPermalink(mediaId: string, token: string): Promise<string | null> {
    try {
      const r = await this.json<any>(
        this.graph(`/${mediaId}`) +
          '?' +
          new URLSearchParams({ fields: 'permalink', access_token: token }),
      );
      return r.permalink ?? null;
    } catch {
      return null;
    }
  }

  /* ── Insights ─────────────────────────────────────────────────────────── */

  async getPostMetrics(
    tokens: TokenSet,
    account: AccountInfo,
    externalId: string,
  ): Promise<Partial<PostMetrics>> {
    const token = this.publishToken(tokens, account);
    // Metric availability varies by media type; ask broadly and map what returns.
    const metrics = [
      'reach',
      'likes',
      'comments',
      'shares',
      'saved',
      'views',
      'total_interactions',
      'profile_visits',
      'ig_reels_avg_watch_time',
      'ig_reels_video_view_total_time',
    ].join(',');

    try {
      const r = await this.json<any>(
        this.graph(`/${externalId}/insights`) +
          '?' +
          new URLSearchParams({ metric: metrics, access_token: token }),
      );
      const out = emptyMetrics();
      for (const entry of r.data ?? []) {
        const value = Number(entry.values?.[0]?.value ?? entry.total_value?.value ?? 0);
        switch (entry.name) {
          case 'reach':
            out.reach = value;
            break;
          case 'views':
            out.views = value;
            out.impressions = value;
            break;
          case 'likes':
            out.likes = value;
            break;
          case 'comments':
            out.comments = value;
            break;
          case 'shares':
            out.shares = value;
            break;
          case 'saved':
            out.saves = value;
            break;
          case 'profile_visits':
            out.profile_visits = value;
            break;
          case 'ig_reels_video_view_total_time':
            // Reported in milliseconds.
            out.watch_time_seconds = Math.round(value / 1000);
            break;
        }
      }
      if (out.views > 0 && out.reach === 0) out.reach = out.views;
      return out;
    } catch (e) {
      log.warn('instagram insights unavailable', { externalId, error: String(e) });
      return {};
    }
  }

  async getAccountMetrics(tokens: TokenSet, account: AccountInfo): Promise<Partial<PostMetrics>> {
    const token = this.publishToken(tokens, account);
    try {
      const r = await this.json<any>(
        this.graph(`/${account.externalId}/insights`) +
          '?' +
          new URLSearchParams({
            metric: 'reach,profile_views,website_clicks,follower_count',
            period: 'day',
            metric_type: 'total_value',
            access_token: token,
          }),
      );
      const out: Partial<PostMetrics> = {};
      for (const entry of r.data ?? []) {
        const value = Number(entry.total_value?.value ?? entry.values?.[0]?.value ?? 0);
        if (entry.name === 'reach') out.reach = value;
        if (entry.name === 'profile_views') out.profile_visits = value;
        if (entry.name === 'website_clicks') out.clicks = value;
        if (entry.name === 'follower_count') out.follows = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Meta exposes the real remaining quota — use it rather than guessing. */
  async getQuota(
    tokens: TokenSet,
    account: AccountInfo,
  ): Promise<{ used: number; limit: number } | null> {
    const token = this.publishToken(tokens, account);
    try {
      const r = await this.json<any>(
        this.graph(`/${account.externalId}/content_publishing_limit`) +
          '?' +
          new URLSearchParams({ fields: 'config,quota_usage', access_token: token }),
      );
      const row = r.data?.[0];
      if (!row) return null;
      return { used: row.quota_usage ?? 0, limit: row.config?.quota_total ?? 100 };
    } catch {
      return null;
    }
  }

  /* ── Plumbing ─────────────────────────────────────────────────────────── */

  private assertConfigured(): void {
    if (!this.configured) {
      throw new FullSendError('platform_not_configured', 'Instagram is not configured', {
        remedy:
          'Add META_APP_ID and META_APP_SECRET, then complete the Instagram setup wizard in ' +
          'FullSend → Accounts.',
      });
    }
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    if (!res.ok || body.error) {
      throw mapMetaError(body.error ?? { message: `HTTP ${res.status}` }, res.status);
    }
    return body as T;
  }
}

/** Turns Meta's error codes into something a founder can act on. */
export function mapMetaError(
  error: { message?: string; code?: number; error_subcode?: number; type?: string },
  status = 400,
): FullSendError {
  const message = error.message ?? 'Instagram request failed';
  const code = error.code;

  // 190: token invalid/expired. 102: session expired. 463: password changed.
  if (code === 190 || code === 102 || code === 463 || status === 401) {
    return connectionError(
      'instagram',
      'Your Instagram connection expired',
      'Reconnect Instagram in FullSend → Accounts. Publishing resumes automatically once you do.',
    );
  }
  /*
   * 10 / 200-299: missing permission — but *whose* problem it is matters. An
   * app still in Development Mode refuses every account that does not hold a
   * role on it, and Meta reports that here, in the same bucket as an ordinary
   * missing scope. Reading it as an account problem is what sends somebody off
   * to add another tester instead of taking the application Live once.
   */
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) {
    return (
      classifyMetaAuthFailure(message) ??
      connectionError(
        'instagram',
        `Instagram denied this action: ${message}`,
        'The instagram_business_content_publish permission is missing or not yet approved. ' +
          'Check App Review status in the Meta dashboard.',
      )
    );
  }
  // 4 / 17 / 32 / 613: rate limiting.
  if (code === 4 || code === 17 || code === 32 || code === 613 || status === 429) {
    return new FullSendError('rate_limited', 'Instagram rate limit reached', {
      status: 429,
      retryable: true,
      remedy: 'FullSend will space out the next publish and retry.',
    });
  }
  // 9: publishing limit (100 per 24h).
  if (code === 9) {
    return new FullSendError('quota_exhausted', 'Instagram daily publishing limit reached', {
      status: 429,
      retryable: true,
      remedy: 'Instagram allows 100 API posts per 24 hours. FullSend will publish this tomorrow.',
    });
  }
  if (code === 100) {
    return new FullSendError('publish_failed', `Instagram rejected the request: ${message}`, {
      remedy: 'Usually a media URL or format problem. Check the creative and retry.',
    });
  }
  return (
    classifyMetaAuthFailure(message) ??
    new FullSendError('platform_error', `Instagram error: ${message}`, {
      retryable: status >= 500,
      meta: { code, subcode: error.error_subcode },
    })
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Captions come back from Meta with whitespace normalised; compare like for like. */
function normalizeCaption(caption: string): string {
  return caption.replace(/\s+/g, ' ').trim();
}

export function instagramFormatSupported(format: ContentFormat): boolean {
  return ['reel', 'carousel', 'static', 'story'].includes(format);
}
