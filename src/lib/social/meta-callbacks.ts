/**
 * What Meta's deauthorize and data-deletion callbacks actually do.
 *
 * Both arrive as a `signed_request` naming an Instagram-scoped user id, with no
 * session and no project. So the work is the same shape in both: find every
 * connected Instagram account carrying that external id, and cut it off.
 *
 * Shared because the two must not drift. A deauthorize that revokes less than a
 * deletion request would leave a token live after someone removed the app.
 */
import 'server-only';
import { systemScope } from '../db';
import { audit, db } from '../db/repo';
import { logger } from '../logger';
import type { SocialAccount } from '../types';

const log = logger('meta-callbacks');

export interface RevokeResult {
  /** How many connected accounts matched the id Meta sent. */
  accounts: number;
  /** How many token rows were destroyed. */
  tokens: number;
}

/**
 * Revokes every Instagram connection for one Instagram-scoped user id.
 *
 * Runs with a system scope: the request has no session, and Meta identifies the
 * person by their platform id rather than by anything this app issued. The
 * lookup is still keyed to that id, so it can only ever reach rows belonging to
 * the account Meta named.
 */
export async function revokeInstagramFor(externalId: string): Promise<RevokeResult> {
  const scope = systemScope('meta callback');

  const accounts = (await db().find(scope, 'social_accounts', {
    where: { platform: 'instagram', external_id: externalId },
  })) as SocialAccount[];

  let tokens = 0;
  for (const account of accounts) {
    const tokenRow = await db().findOne(scope, 'oauth_tokens', {
      where: { social_account_id: account.id },
    });
    if (tokenRow) {
      await db().remove(scope, 'oauth_tokens', tokenRow.id);
      tokens += 1;
    }

    await db().update(scope, 'social_accounts', account.id, {
      status: 'revoked',
      status_detail: 'Removed from Instagram by the account owner',
    });

    // Anything queued stops rather than retrying against a token that is gone.
    const queued = await db().find(scope, 'scheduled_posts', {
      where: { project_id: account.project_id, platform: 'instagram' },
      whereIn: { status: ['scheduled', 'publishing'] },
    });
    for (const post of queued) {
      await db().update(scope, 'scheduled_posts', post.id, {
        status: 'approval_required',
        last_error: 'Instagram access was removed on Instagram',
      });
    }

    await audit(scope, {
      user_id: null,
      project_id: account.project_id,
      action: 'instagram.revoked_by_platform',
      target: account.id,
      metadata: { externalId },
      ip: null,
    });
  }

  log.info('meta callback revoked instagram', { externalId, accounts: accounts.length, tokens });
  return { accounts: accounts.length, tokens };
}
