import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { errorResponse } from '@/lib/api/handler';
import { check, LIMITS } from '@/lib/rate-limit';
import { encryptSecret, signState } from '@/lib/crypto';
import { env } from '@/lib/env';
import { badRequest, FullSendError } from '@/lib/errors';
import { getProject } from '@/lib/db/repo';
import { getAdapter } from '@/lib/social/registry';
import { PLATFORMS, type Platform } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * Starts the OAuth dance.
 *
 * State is HMAC-signed and short-lived so a callback cannot be forged, and the
 * PKCE verifier is stashed in an httpOnly cookie — never in a query string.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ platform: string }> },
): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { platform: raw } = await ctx.params;

    if (!PLATFORMS.includes(raw as Platform)) throw badRequest(`Unknown platform: ${raw}`);
    const platform = raw as Platform;

    check(`oauth:${session.user.id}`, LIMITS.oauthStart);

    const projectId = req.nextUrl.searchParams.get('project');
    if (!projectId) throw badRequest('No project specified');

    const project = await getProject(session.scope, projectId);
    if (!project) throw badRequest('Project not found');

    const adapter = getAdapter(platform);
    if (!adapter.configured) {
      throw new FullSendError('platform_not_configured', `${platform} is not configured yet`, {
        status: 409,
        remedy: `Complete the ${platform} developer setup first — FullSend walks you through it.`,
        meta: { setupHref: `/app/accounts/${platform}/setup` },
      });
    }

    /*
     * A deployed FullSend that thinks it lives on localhost would hand Meta a
     * callback pointing at the founder's laptop. Meta either rejects it or,
     * worse, sends the authorization code somewhere that cannot receive it —
     * so this stops at the door with the variable that is missing.
     */
    if (env.appUrlIsLocal && env.nodeEnv === 'production') {
      throw new FullSendError(
        'app_url_not_set',
        'FullSend does not know its own public address',
        {
          status: 500,
          remedy:
            'Set NEXT_PUBLIC_APP_URL to the deployment’s https:// URL and redeploy. Every OAuth ' +
            'callback is built from it, and it must match the redirect URI registered with Meta.',
        },
      );
    }

    /*
     * Which account this authorization is for, when the caller already knows.
     *
     * One application serves many accounts, so "connect Instagram" is not on
     * its own a complete instruction: a login that administers several
     * eligible accounts has to be told which one this brand publishes to. The
     * Accounts page passes it after the founder picks, and a reconnect passes
     * the account already connected so it cannot land somewhere else.
     */
    const accountHint = req.nextUrl.searchParams.get('account');

    const redirectUri = `${env.appUrl}/api/accounts/${platform}/callback`;
    const state = signState({
      projectId,
      userId: session.user.id,
      platform,
      accountHint: accountHint ?? null,
    });
    const { url, codeVerifier } = adapter.authorizeUrl(state, redirectUri);

    const response = NextResponse.redirect(url);
    if (codeVerifier) {
      response.cookies.set(`fs_pkce_${platform}`, encryptSecret(codeVerifier, session.user.id), {
        httpOnly: true,
        secure: env.nodeEnv === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 900,
      });
    }
    return response;
  } catch (e) {
    return errorResponse(e, req);
  }
}
