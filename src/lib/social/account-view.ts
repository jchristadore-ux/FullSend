/**
 * What a browser is allowed to know about a connected account.
 *
 * `social_accounts.platform_metadata` is a free-form jsonb column, and under
 * Facebook Login the adapter was putting a live Page access token in it. The
 * accounts API returns account rows to the page that renders them, so that
 * token travelled to the browser on every load — a publishing credential in a
 * JSON payload, for anyone with devtools open.
 *
 * The credential now lives in the encrypted vault. This module is the second
 * half of that fix: an explicit allow-list, so the next thing somebody stores
 * in `platform_metadata` cannot leak by default. A field reaches the client
 * because it is named here, not because nobody thought about it.
 *
 * Client-safe: no server imports, no environment access.
 */
import type { ConnectionStatus, Platform, SocialAccount, Uuid } from '../types';

/** Metadata keys that are facts about an account rather than credentials. */
const PUBLIC_METADATA_KEYS = [
  'account_type',
  'login_mode',
  'page_id',
  'page_name',
  'privacy_options',
  'creator_nickname',
  'max_video_seconds',
] as const;

/**
 * Anything matching these is treated as a credential and dropped, whatever it
 * is called. Belt and braces with the allow-list above: a key named
 * `page_access_token` would already be excluded, and this catches the one
 * somebody adds without reading this file.
 */
const SECRET_KEY_PATTERN = /(token|secret|password|credential|signature|key)/i;

export interface PublicSocialAccount {
  id: Uuid;
  project_id: Uuid;
  platform: Platform;
  external_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  status: ConnectionStatus;
  status_detail: string | null;
  granted_scopes: string[];
  followers: number;
  last_checked_at: string | null;
  connected_at: string;
  /** Facts only — see `PUBLIC_METADATA_KEYS`. */
  platform_metadata: Record<string, unknown>;
}

export function publicMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!metadata) return out;
  for (const key of PUBLIC_METADATA_KEYS) {
    if (!(key in metadata)) continue;
    if (SECRET_KEY_PATTERN.test(key)) continue;
    out[key] = metadata[key];
  }
  return out;
}

/** The shape every API hands back for a connected account. */
export function publicAccount(account: SocialAccount): PublicSocialAccount;
export function publicAccount(account: SocialAccount | null | undefined): PublicSocialAccount | null;
export function publicAccount(
  account: SocialAccount | null | undefined,
): PublicSocialAccount | null {
  if (!account) return null;
  return {
    id: account.id,
    project_id: account.project_id,
    platform: account.platform,
    external_id: account.external_id,
    username: account.username,
    display_name: account.display_name,
    avatar_url: account.avatar_url,
    status: account.status,
    status_detail: account.status_detail,
    granted_scopes: account.granted_scopes,
    followers: account.followers,
    last_checked_at: account.last_checked_at,
    connected_at: account.connected_at,
    platform_metadata: publicMetadata(account.platform_metadata),
  };
}

export function publicAccounts(accounts: SocialAccount[]): PublicSocialAccount[] {
  return accounts.map((a) => publicAccount(a));
}
