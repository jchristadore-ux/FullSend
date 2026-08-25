/**
 * Rescues a sign-in link that arrives at the wrong door.
 *
 * Supabase builds the magic link from its own Site URL, and only honours the
 * callback address we ask for if that exact address is on its Redirect URLs
 * list. Miss that one setting and it drops the code at the site root instead —
 * where nothing is listening, so a link that worked perfectly presents as a
 * broken page and the founder has no way to tell those apart.
 *
 * The code is valid. Forwarding it to the route that can spend it turns a dead
 * end into a sign-in.
 *
 * Note the file name: `middleware.ts` is deprecated in Next 16 and renamed to
 * `proxy.ts`.
 */
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(req: NextRequest): NextResponse {
  const { searchParams } = req.nextUrl;

  // A PKCE code at the root can only have come from an auth redirect.
  const code = searchParams.get('code');
  if (code) {
    const to = req.nextUrl.clone();
    to.pathname = '/api/auth/callback';
    return NextResponse.redirect(to);
  }

  // Supabase reports its own failures the same way, and they belong on the
  // sign-in screen with the rest of the auth errors rather than silently
  // decorating the marketing page.
  const error = searchParams.get('error_description') ?? searchParams.get('error');
  if (error) {
    const to = req.nextUrl.clone();
    to.pathname = '/login';
    to.search = `?error=${encodeURIComponent(error)}`;
    return NextResponse.redirect(to);
  }

  return NextResponse.next();
}

// Only the root. Everything else already routes correctly, and a broad matcher
// would put this in front of every asset request.
export const config = {
  matcher: '/',
};
