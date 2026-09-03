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
 * half of that fix, in two layers. Nothing credential-shaped is *stored* in
 * `platform_metadata` at all (`withoutSecrets`), and what a browser sees is an
 * explicit allow-list on top of that (`publicMetadata`) — so a field reaches a
 * client because it is named here, not because nobody thought about it. The
 * two are separate on purpose: adapters legitimately store facts publishing
 * needs, and quietly dropping those breaks a platform instead of a leak.
 *
 * Client-safe: no server imports, no environment access.
 */
import type { ConnectionStatus, Platform, SocialAccount, Uuid } from '../types';

/**
 * Metadata keys a browser may see.
 *
 * An allow-list rather than a deny-list, because this is the payload that
 * leaves the server: a field reaches a client because it is named here, not
 * because nobody thought about it. Adapters are free to store more than this —
 * see `withoutSecrets` — and publishing reads what it needs server-side.
 */
const PUBLIC_METADATA_KEYS = [
  'account_type',
  'login_mode',
  'page_id',
  'page_name',
  'client_audited',
  'privacy_level_options',
  'max_video_post_duration_sec',
  'comment_disabled',
  'duet_disabled',
  'stitch_disabled',
] as const;

/**
 * Anything matching these is treated as a credential, whatever it is called.
 *
 * Used on the way *in* as well as on the way out. `platform_metadata` is a
 * free-form column an adapter can put anything in, and a Page access token
 * went into it once already; a credential that is never written cannot leak
 * from a column nobody remembered to check.
 */
const SECRET_KEY_PATTERN = /(token|secret|password|credential|signature|_key$|^key$|apikey)/i;

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

/**
 * What is safe to *store* on an account row.
 *
 * Deliberately not the allow-list. Adapters store facts publishing genuinely
 * needs — TikTok's privacy options and duration limits, Meta's Page id — and
 * discarding them because a list was not updated breaks the platform quietly.
 * What must never be stored here is a credential: those belong in the
 * encrypted vault, keyed to one account.
 */
export function withoutSecrets(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!metadata) return out;
  for (const [key, value] of Object.entries(metadata)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    out[key] = value;
  }
  return out;
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
