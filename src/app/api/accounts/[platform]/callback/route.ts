import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { errorResponse } from '@/lib/api/handler';
import { decryptSecret, verifyState } from '@/lib/crypto';
import { env } from '@/lib/env';
import { badRequest, FullSendError } from '@/lib/errors';
import { db, getProject, notify } from '@/lib/db/repo';
import { logger } from '@/lib/logger';
import { completeConnection } from '@/lib/social/connections';
import { resumeAfterReconnect } from '@/lib/publish/publish';
import { getAdapter } from '@/lib/social/registry';
import { classifyMetaAuthFailure } from '@/lib/social/meta-app';
import { PLATFORMS, type Platform } from '@/lib/types';
import { platformLabel } from '@/lib/platform-labels';

export const runtime = 'nodejs';
export const maxDuration = 60;

const log = logger('oauth-callback');

/**
 * Completes the OAuth dance: verifies state, exchanges the code, verifies the
 * account is actually usable, stores the token encrypted, and releases anything
 * that stalled while the platform was disconnected.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ platform: string }> },
): Promise<NextResponse> {
  const { platform: raw } = await ctx.params;
  const settingsUrl = `${env.appUrl}/app/accounts`;

  try {
    const session = await requireSession();
    if (!PLATFORMS.includes(raw as Platform)) throw badRequest(`Unknown platform: ${raw}`);
    const platform = raw as Platform;

    const params = req.nextUrl.searchParams;

    /*
     * The user declined, or the platform refused.
     *
     * "Refused" covers two very different things, and telling them apart is
     * the difference between one click and a week of confusion. An app still
     * in Development Mode turns away every account without a role on it, and
     * Meta reports that here as an ordinary authorization error — which reads
     * as "this account cannot be connected" when it actually means "this
     * application is not open yet". `classifyMetaAuthFailure` names it, once,
     * with the application-level fix.
     */
    const oauthError = params.get('error_description') ?? params.get('error');
    if (oauthError) {
      const appLevel = platform === 'instagram' ? classifyMetaAuthFailure(oauthError) : null;
      if (appLevel) {
        log.warn('meta refused at the application level', { platform, detail: oauthError });
        return NextResponse.redirect(
          `${settingsUrl}?error=${encodeURIComponent(`${appLevel.message} — ${appLevel.remedy}`)}`,
        );
      }
      return NextResponse.redirect(
        `${settingsUrl}?error=${encodeURIComponent(`${platform} sign-in was cancelled: ${oauthError}`)}`,
      );
    }

    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) throw badRequest('The callback was missing its code or state');

    const verified = verifyState<{
      projectId: string;
      userId: string;
      platform: string;
      accountHint?: string | null;
    }>(state);
    if (verified.userId !== session.user.id || verified.platform !== platform) {
      throw new FullSendError('oauth_state_mismatch', 'This sign-in did not match your session', {
        status: 400,
        remedy: 'Start the connection again from the Accounts page.',
      });
    }

    const project = await getProject(session.scope, verified.projectId);
    if (!project) throw badRequest('Project not found');

    const adapter = getAdapter(platform);
    const redirectUri = `${env.appUrl}/api/accounts/${platform}/callback`;

    let codeVerifier: string | undefined;
    const pkceCookie = req.cookies.get(`fs_pkce_${platform}`)?.value;
    if (pkceCookie) {
      try {
        codeVerifier = decryptSecret(pkceCookie, session.user.id);
      } catch {
        throw new FullSendError('oauth_state_lost', 'The sign-in session expired', {
          status: 400,
          remedy: 'Start the connection again.',
        });
      }
    }

    const tokens = await adapter.exchangeCode(code, redirectUri, codeVerifier);

    /*
     * Which account, of the ones this login can reach.
     *
     * The founder's explicit choice wins. Failing that, the account this
     * project is already connected to — so a reconnect stays put rather than
     * silently rebinding the brand to whichever account the platform happened
     * to list first. Only a genuinely new connection with exactly one eligible
     * account resolves without being told, and the adapter asks rather than
     * guesses when there is more than one.
     */
    const connected = await db().findOne(session.scope, 'social_accounts', {
      where: { project_id: project.id, platform },
    });
    const preferred =
      verified.accountHint ??
      (connected && connected.status !== 'disconnected' ? connected.external_id : null);

    // Verifying the account here is what surfaces "this is a Creator account,
    // not a Business account" at connect time rather than at first publish.
    const info = await adapter.getAccount(tokens, preferred);

    const account = await completeConnection(session.scope, project, platform, tokens, info);
    const resumed = await resumeAfterReconnect(session.scope, project.id, platform);

    await notify(session.scope, {
      user_id: session.user.id,
      project_id: project.id,
      severity: 'success',
      title: `${platformLabel(platform)} connected`,
      body: resumed
        ? `Connected as @${info.username}. ${resumed} paused post${resumed === 1 ? '' : 's'} released back to the queue.`
        : `Connected as @${info.username}. FullSend will publish on schedule.`,
      action_label: 'Open the calendar',
      action_href: '/app/calendar',
    });

    log.info('platform connected via oauth', {
      platform,
      projectId: project.id,
      resumed,
      accountId: account.id,
    });

    const response = NextResponse.redirect(`${settingsUrl}?connected=${platform}`);
    response.cookies.delete(`fs_pkce_${platform}`);
    return response;
  } catch (e) {
    const message =
      e instanceof FullSendError ? `${e.message}${e.remedy ? ` — ${e.remedy}` : ''}` : String(e);
    log.warn('oauth callback failed', { platform: raw, error: message });

    // A failed connection returns the founder to the page with the reason, not
    // a JSON error blob in the browser.
    if (e instanceof FullSendError && e.status === 401) return errorResponse(e, req);

    /*
     * More than one eligible account and nothing said which. Not an error to
     * report — a question to ask. The candidates ride back on the URL (ids and
     * usernames, nothing secret) and the Accounts page renders one Connect
     * button per account, which comes straight back here with the choice made.
     */
    if (e instanceof FullSendError && e.code === 'instagram_account_choice_required') {
      const candidates = Array.isArray(e.meta?.candidates) ? e.meta.candidates : [];
      const pick = Buffer.from(JSON.stringify(candidates), 'utf8').toString('base64url');
      return NextResponse.redirect(
        `${settingsUrl}?choose=${raw}&candidates=${encodeURIComponent(pick)}`,
      );
    }
    return NextResponse.redirect(`${settingsUrl}?error=${encodeURIComponent(message)}`);
  }
}
