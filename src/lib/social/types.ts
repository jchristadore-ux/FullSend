/**
 * The platform adapter contract.
 *
 * Every platform implements the same interface, and each one declares honestly
 * what it can actually do — publishing, native scheduling, analytics, story
 * support. The UI reads those declarations rather than assuming parity, so the
 * product never offers a button the API cannot honour.
 */

import type { ContentFormat, PostMetrics, Platform } from '../types';

export interface PlatformCapabilities {
  /** Publish directly via the API without human confirmation. */
  directPublish: boolean;
  /** Platform-side scheduling. Neither Meta nor TikTok offers it here, so
   *  FullSend schedules server-side and publishes at the moment it is due. */
  nativeScheduling: boolean;
  postAnalytics: boolean;
  accountAnalytics: boolean;
  supportedFormats: ContentFormat[];
  /** Media must be at a public URL the platform's servers can fetch. */
  requiresPublicMediaUrl: boolean;
  /** Posts per rolling 24h the platform permits. */
  dailyPostLimit: number | null;
  /** Set when review/audit gates full functionality. Surfaced in the UI. */
  restrictions: string[];
}

export interface PublishInput {
  caption: string;
  format: ContentFormat;
  /** Publicly reachable media. Video for reels/short video, images otherwise. */
  mediaUrls: string[];
  videoUrl?: string | null;
  coverUrl?: string | null;
  /** TikTok requires an explicit privacy level chosen from creator_info. */
  privacyLevel?: string;
  /** Instagram Reels: also surface in the main feed. */
  shareToFeed?: boolean;
  disableComments?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;

  /**
   * A container this post already has on the platform. Supplied on a retry so
   * the adapter resumes the attempt already in flight instead of uploading the
   * media again — one post, one container, however many attempts it takes.
   */
  resumeContainerId?: string | null;
  /** Called the moment a container exists, before anything is published. */
  onContainer?: (containerId: string) => Promise<void>;
  /** Called immediately before the publish call goes out. */
  onSubmit?: (containerId: string) => Promise<void>;
}

export interface PublishResult {
  externalId: string;
  permalink: string | null;
  /** Verbatim platform response — the receipt that the post really happened. */
  raw: Record<string, unknown>;
}

export interface AccountInfo {
  externalId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  followers: number;
  /**
   * Platform-specific facts the publisher needs, e.g. privacy options.
   *
   * Facts only. This travels to the browser with the account row, so nothing
   * secret belongs in it — a credential goes in `platformToken`, which is
   * stored encrypted and never leaves the server.
   */
  metadata: Record<string, unknown>;
  /**
   * A second credential the platform issues for this specific account, such as
   * a Facebook Page access token. Kept apart from `metadata` because it is a
   * credential, and apart from the user token because it belongs to one
   * account rather than to the login.
   */
  platformToken?: string | null;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  refreshExpiresAt: Date | null;
  scopes: string[];
  /**
   * The account-scoped credential from `AccountInfo.platformToken`, once it has
   * been through the vault. Present only for platforms that issue one.
   */
  platformToken?: string | null;
}

export interface OAuthStartResult {
  url: string;
  /** Stashed in a signed cookie and required back at the callback. */
  codeVerifier?: string;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  readonly capabilities: PlatformCapabilities;
  /** False when app credentials are missing — the UI then shows setup, not a button. */
  readonly configured: boolean;

  authorizeUrl(state: string, redirectUri: string): OAuthStartResult;
  exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<TokenSet>;
  refresh(tokens: TokenSet): Promise<TokenSet>;
  /**
   * The account this authorization is for.
   *
   * `preferredExternalId` pins a reconnect to the account already connected,
   * so a login that can reach several accounts cannot silently rebind a brand
   * to a different one.
   */
  getAccount(tokens: TokenSet, preferredExternalId?: string | null): Promise<AccountInfo>;
  /**
   * Every account this authorization could publish to. One application serves
   * many accounts, and this is the list that makes choosing between them
   * possible rather than accidental.
   */
  listAccounts?(tokens: TokenSet): Promise<AccountInfo[]>;
  publish(tokens: TokenSet, account: AccountInfo, input: PublishInput): Promise<PublishResult>;
  /**
   * Asks the platform whether a submitted container already went live.
   *
   * The one question that makes a publish retry safe. Returns the real post
   * when the platform has one, null when it genuinely does not, and throws if
   * it cannot tell — an adapter must never answer "no" out of ignorance,
   * because that answer publishes the post a second time.
   */
  findPublished?(
    tokens: TokenSet,
    account: AccountInfo,
    attempt: { containerId: string; caption: string },
  ): Promise<PublishResult | null>;
  getPostMetrics(
    tokens: TokenSet,
    account: AccountInfo,
    externalId: string,
  ): Promise<Partial<PostMetrics>>;
  getAccountMetrics(tokens: TokenSet, account: AccountInfo): Promise<Partial<PostMetrics>>;
  /** Remaining posts in the platform's rolling window, when it exposes one. */
  getQuota?(tokens: TokenSet, account: AccountInfo): Promise<{ used: number; limit: number } | null>;
}

export function emptyMetrics(): PostMetrics {
  return {
    views: 0,
    reach: 0,
    impressions: 0,
    watch_time_seconds: 0,
    completion_rate: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    profile_visits: 0,
    clicks: 0,
    conversions: 0,
    follows: 0,
  };
}
