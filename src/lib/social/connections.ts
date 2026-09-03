/**
 * Social connection lifecycle.
 *
 * Owns the token vault (encrypt on write, decrypt only server-side, never
 * returned to a client), the connect/disconnect flow, proactive refresh, and
 * the health check that turns an expired token into an actionable notification
 * rather than a silent stall.
 */
import 'server-only';
import { decryptSecret, encryptSecret } from '../crypto';
import { systemScope, type TenantScope } from '../db';
import { audit, db, getSocialAccount, notify } from '../db/repo';
import { connectionError, FullSendError } from '../errors';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import type { ConnectionStatus, Platform, Project, SocialAccount, Uuid } from '../types';
import { getAdapter } from './registry';
import { platformLabel } from '../platform-labels';
import { withoutSecrets } from './account-view';
import type { AccountInfo, TokenSet } from './types';

const log = logger('connections');

/** Refresh this far ahead of expiry so publishing never races the clock. */
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

/* ── Vault ──────────────────────────────────────────────────────────────── */

export async function storeTokens(
  scope: TenantScope,
  account: SocialAccount,
  tokens: TokenSet,
): Promise<void> {
  // AAD binds the ciphertext to this account: a stolen row cannot be replayed.
  const aad = `${account.project_id}:${account.id}`;
  const patch = {
    access_token_encrypted: encryptSecret(tokens.accessToken, aad),
    refresh_token_encrypted: tokens.refreshToken ? encryptSecret(tokens.refreshToken, aad) : null,
    /*
     * The account-scoped credential — a Facebook Page token, under Facebook
     * Login. Encrypted under the same AAD as the user token, so it is bound to
     * this account and this project: a row lifted into another brand's project
     * decrypts to nothing.
     */
    platform_token_encrypted: tokens.platformToken
      ? encryptSecret(tokens.platformToken, aad)
      : null,
    expires_at: tokens.expiresAt?.toISOString() ?? null,
    refresh_expires_at: tokens.refreshExpiresAt?.toISOString() ?? null,
    scopes: tokens.scopes,
    updated_at: nowIso(),
  };

  const existing = await db().findOne(scope, 'oauth_tokens', {
    where: { social_account_id: account.id },
  });
  if (existing) {
    await db().update(scope, 'oauth_tokens', existing.id, patch);
  } else {
    await db().insert(scope, 'oauth_tokens', {
      id: newId(),
      social_account_id: account.id,
      project_id: account.project_id,
      ...patch,
    });
  }
}

export async function loadTokens(
  scope: TenantScope,
  account: SocialAccount,
): Promise<TokenSet | null> {
  const row = await db().findOne(scope, 'oauth_tokens', {
    where: { social_account_id: account.id },
  });
  if (!row) return null;
  const aad = `${account.project_id}:${account.id}`;
  try {
    return {
      accessToken: decryptSecret(row.access_token_encrypted, aad),
      refreshToken: row.refresh_token_encrypted
        ? decryptSecret(row.refresh_token_encrypted, aad)
        : null,
      platformToken: row.platform_token_encrypted
        ? decryptSecret(row.platform_token_encrypted, aad)
        : null,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      refreshExpiresAt: row.refresh_expires_at ? new Date(row.refresh_expires_at) : null,
      scopes: row.scopes,
    };
  } catch (e) {
    log.error('token decryption failed', { accountId: account.id, error: String(e) });
    throw connectionError(
      account.platform,
      'Stored credentials could not be read',
      `Reconnect ${account.platform} in FullSend → Accounts.`,
    );
  }
}

/* ── Connect / disconnect ───────────────────────────────────────────────── */

/**
 * Attaches an authorized account to a brand.
 *
 * One Meta application serves every brand FullSend runs, so this is the point
 * where "which application" stops mattering and "which account, for which
 * brand" starts. Three things are true on the way out, and each of them is
 * asserted here rather than assumed downstream:
 *
 *   • the credential is in the vault, encrypted and bound to this account;
 *   • nothing secret is left in `platform_metadata`, which reaches browsers;
 *   • this account is not already publishing for a different brand.
 */
export async function completeConnection(
  scope: TenantScope,
  project: Project,
  platform: Platform,
  tokens: TokenSet,
  info: AccountInfo,
): Promise<SocialAccount> {
  const existing = await getSocialAccount(scope, project.id, platform);
  await assertNotConnectedElsewhere(scope, project, platform, info, existing?.id ?? null);

  /*
   * The account-scoped credential travels with the token set from here on,
   * never in the metadata blob. `metadata` is stored on a row that the
   * accounts API returns to the browser; a Page token in it is a published
   * credential, whatever anybody intended.
   */
  const vaulted: TokenSet = {
    ...tokens,
    platformToken: info.platformToken ?? tokens.platformToken ?? null,
  };

  const patch = {
    external_id: info.externalId,
    username: info.username,
    display_name: info.displayName,
    avatar_url: info.avatarUrl,
    status: 'connected' as ConnectionStatus,
    status_detail: null,
    granted_scopes: tokens.scopes,
    platform_metadata: withoutSecrets(info.metadata),
    followers: info.followers,
    last_checked_at: nowIso(),
  };

  const account = existing
    ? await db().update(scope, 'social_accounts', existing.id, patch)
    : await db().insert(scope, 'social_accounts', {
        id: newId(),
        project_id: project.id,
        platform,
        connected_at: nowIso(),
        ...patch,
      });

  await storeTokens(scope, account, vaulted);
  await audit(scope, {
    user_id: project.user_id,
    project_id: project.id,
    action: 'social.connected',
    target: `${platform}:${info.username}`,
    metadata: { scopes: tokens.scopes },
    ip: null,
  });

  // Reconnecting clears the stop: publishing resumes on its own.
  const stalled = await db().find(scope, 'automation_errors', {
    where: { project_id: project.id, resolved: false },
  });
  for (const err of stalled) {
    if (err.scope.startsWith(`publish:${platform}`) || err.scope === `connection:${platform}`) {
      await db().update(scope, 'automation_errors', err.id, { resolved: true });
    }
  }

  log.info('platform connected', { project: project.id, platform, username: info.username });
  return account;
}

/**
 * Refuses to connect an account that already belongs to another brand.
 *
 * Two projects publishing to one Instagram account is not a configuration
 * anybody asks for on purpose, and it is indistinguishable from the mistake it
 * usually is: connecting during onboarding while signed in to the wrong
 * account. Left alone, both brands' calendars publish to the same feed, and
 * the cross-project guard cannot catch it because each post really is going to
 * its own project's account.
 *
 * A *disconnected* row elsewhere is not a conflict — that is a brand that gave
 * the account up, and taking it over is the point.
 */
async function assertNotConnectedElsewhere(
  scope: TenantScope,
  project: Project,
  platform: Platform,
  info: AccountInfo,
  allowAccountId: Uuid | null,
): Promise<void> {
  const sameAccount = await db().find(systemScope('connection conflict check'), 'social_accounts', {
    where: { platform, external_id: info.externalId },
  });
  const conflict = sameAccount.find(
    (a) =>
      a.id !== allowAccountId &&
      a.project_id !== project.id &&
      a.status !== 'disconnected',
  );
  if (!conflict) return;

  const other = await db().get(systemScope('connection conflict check'), 'projects', conflict.project_id);
  log.warn('refused a second brand on one account', {
    platform,
    externalId: info.externalId,
    project: project.id,
    heldBy: conflict.project_id,
  });
  throw new FullSendError(
    'account_already_connected',
    `@${info.username} is already connected to ${other?.name ?? 'another project'} in FullSend`,
    {
      status: 409,
      retryable: false,
      remedy:
        `One Instagram account publishes for one brand. Disconnect it from ${other?.name ?? 'the other project'} ` +
        `first if you mean to move it to ${project.name}, or sign in to the account that belongs to ` +
        `${project.name} and connect that one instead.`,
      meta: { heldByProject: conflict.project_id },
    },
  );
}

export async function disconnect(
  scope: TenantScope,
  project: Project,
  platform: Platform,
): Promise<void> {
  const account = await getSocialAccount(scope, project.id, platform);
  if (!account) return;

  const tokenRow = await db().findOne(scope, 'oauth_tokens', {
    where: { social_account_id: account.id },
  });
  if (tokenRow) await db().remove(scope, 'oauth_tokens', tokenRow.id);

  await db().update(scope, 'social_accounts', account.id, {
    status: 'disconnected',
    status_detail: 'Disconnected by the account owner',
  });

  // Anything queued for this platform stops rather than failing repeatedly.
  const queued = await db().find(scope, 'scheduled_posts', {
    where: { project_id: project.id, platform },
    whereIn: { status: ['scheduled', 'publishing'] },
  });
  for (const post of queued) {
    await db().update(scope, 'scheduled_posts', post.id, {
      status: 'approval_required',
      last_error: `${platform} was disconnected`,
    });
  }

  await audit(scope, {
    user_id: project.user_id,
    project_id: project.id,
    action: 'social.disconnected',
    target: platform,
    metadata: { queuedPaused: queued.length },
    ip: null,
  });
}

/* ── Health & refresh ───────────────────────────────────────────────────── */

export interface UsableConnection {
  account: SocialAccount;
  tokens: TokenSet;
  info: AccountInfo;
}

/**
 * Returns a connection ready to publish with, refreshing the token first if it
 * is close to expiry. Throws an actionable connection error otherwise — the
 * publisher turns that into the "NEEDS ATTENTION" banner.
 */
export async function getUsableConnection(
  scope: TenantScope,
  projectId: Uuid,
  platform: Platform,
): Promise<UsableConnection> {
  const account = await getSocialAccount(scope, projectId, platform);
  if (!account || account.status === 'disconnected') {
    throw connectionError(
      platform,
      `${platformLabel(platform)} is not connected`,
      `Connect ${platformLabel(platform)} in FullSend → Accounts to start publishing.`,
    );
  }

  let tokens = await loadTokens(scope, account);
  if (!tokens) {
    await markNeedsAttention(scope, account, 'No stored credentials');
    throw connectionError(
      platform,
      `${platformLabel(platform)} credentials are missing`,
      `Reconnect ${platformLabel(platform)} in FullSend → Accounts.`,
    );
  }

  const adapter = getAdapter(platform);
  const expiringSoon =
    tokens.expiresAt !== null && tokens.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;

  if (expiringSoon) {
    try {
      tokens = await adapter.refresh(tokens);
      await storeTokens(scope, account, tokens);
      log.info('token refreshed', { platform, accountId: account.id });
    } catch (e) {
      const expired = tokens.expiresAt !== null && tokens.expiresAt.getTime() <= Date.now();
      if (expired) {
        await markNeedsAttention(scope, account, 'Token expired and could not be refreshed');
        throw connectionError(
          platform,
          `Your ${platformLabel(platform)} connection expired`,
          `Reconnect ${platformLabel(platform)} in FullSend → Accounts. Publishing resumes automatically.`,
        );
      }
      // Still valid for now — carry on and try again next cycle.
      log.warn('token refresh failed but token is still valid', { platform, error: String(e) });
    }
  }

  const info: AccountInfo = {
    externalId: account.external_id,
    username: account.username,
    displayName: account.display_name,
    avatarUrl: account.avatar_url,
    followers: account.followers,
    metadata: account.platform_metadata,
  };

  return { account, tokens, info };
}

export async function markNeedsAttention(
  scope: TenantScope,
  account: SocialAccount,
  detail: string,
): Promise<void> {
  if (account.status === 'expired' && account.status_detail === detail) return;
  await db().update(scope, 'social_accounts', account.id, {
    status: 'expired',
    status_detail: detail,
    last_checked_at: nowIso(),
  });

  const project = await db().get(scope, 'projects', account.project_id);
  if (!project) return;

  await notify(scope, {
    user_id: project.user_id,
    project_id: project.id,
    severity: 'error',
    title: `${platformLabel(account.platform)} needs attention`,
    body: `${detail}. FullSend has paused publishing to ${platformLabel(account.platform)} and will resume the moment you reconnect.`,
    action_label: `Reconnect ${platformLabel(account.platform)}`,
    action_href: `/app/accounts?reconnect=${account.platform}`,
  });
}

/** Daily sweep: verify every connection is still good before it is needed. */
export async function checkAllConnections(projectId: Uuid): Promise<{
  healthy: number;
  needsAttention: { platform: Platform; detail: string }[];
}> {
  const scope = systemScope('connection health check');
  const accounts = await db().find(scope, 'social_accounts', {
    where: { project_id: projectId },
  });

  let healthy = 0;
  const needsAttention: { platform: Platform; detail: string }[] = [];

  for (const account of accounts) {
    if (account.status === 'disconnected') continue;
    try {
      await getUsableConnection(scope, projectId, account.platform);
      if (account.status !== 'connected') {
        await db().update(scope, 'social_accounts', account.id, {
          status: 'connected',
          status_detail: null,
          last_checked_at: nowIso(),
        });
      } else {
        await db().update(scope, 'social_accounts', account.id, { last_checked_at: nowIso() });
      }
      healthy++;
    } catch (e) {
      const detail = e instanceof FullSendError ? e.message : String(e);
      needsAttention.push({ platform: account.platform, detail });
    }
  }

  return { healthy, needsAttention };
}
