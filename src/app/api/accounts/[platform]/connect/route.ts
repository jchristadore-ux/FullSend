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

    const redirectUri = `${env.appUrl}/api/accounts/${platform}/callback`;
    const state = signState({ projectId, userId: session.user.id, platform });
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
