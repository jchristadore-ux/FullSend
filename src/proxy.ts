/**
 * Keeps the session alive, and rescues a sign-in link that arrives at the
 * wrong door.
 *
 * ── Why the refresh has to happen here ──────────────────────────────────────
 *
 * Supabase access tokens expire and are rotated: refreshing spends the old
 * refresh token and issues a new pair, which must be written back to cookies
 * or the next request arrives holding a token that has already been used.
 *
 * A Server Component cannot write cookies. Next throws if it tries, and the
 * cookie adapter in `lib/auth/session.ts` catches that — it has to, or every
 * authenticated page would crash. The consequence is that a refresh triggered
 * from a page silently discards the new tokens. The old refresh token is spent
 * either way, so the session is gone on the very next request: sign in, land
 * on the Send Center, reload, and you are back at the sign-in screen asking
 * for another link. Forever.
 *
 * Middleware runs before the page and owns the response, so it is the one
 * place a refresh can actually persist. That is what the catch in the cookie
 * adapter has always been deferring to, and until now it was deferring to
 * nothing.
 *
 * ── The other job ──────────────────────────────────────────────────────────
 *
 * Supabase builds the magic link from its own Site URL, and only honours the
 * callback address we ask for if that exact address is on its Redirect URLs
 * list. Miss that one setting and it drops the code at the site root instead —
 * where nothing is listening, so a link that worked perfectly presents as a
 * broken page and the founder has no way to tell those apart.
 *
 * Note the file name: `middleware.ts` is deprecated in Next 16 and renamed to
 * `proxy.ts`.
 */
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/*
 * Read statically, not through a computed key.
 *
 * Middleware runs on the Edge runtime, which has no live `process.env` to look
 * things up in — only the NEXT_PUBLIC_ values Next inlines at build time. Both
 * of these are public by definition (they ship in the browser bundle), and
 * changing either means a redeploy, which is how they are changed anyway.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const { searchParams, pathname } = req.nextUrl;

  if (pathname === '/') {
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
  }

  return refreshSession(req);
}

/**
 * Touches the session so Supabase can rotate it, and carries the new cookies
 * out on the response.
 *
 * `getUser()` is what triggers a refresh when the access token is close to
 * expiry; the cookie adapter below is what makes the result stick. Both halves
 * are needed — calling one without the other is the bug this fixes.
 */
async function refreshSession(req: NextRequest): Promise<NextResponse> {
  // Expose the matched path to Server Components (e.g. app layout login redirect).
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-pathname', `${req.nextUrl.pathname}${req.nextUrl.search}`);

  // Not configured: the app runs on its local dev session instead, and there
  // is nothing to refresh.
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  let res = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (toSet) => {
        // Update the request too, so a page rendered in this same pass reads
        // the refreshed token rather than the one that just expired.
        for (const { name, value } of toSet) req.cookies.set(name, value);
        res = NextResponse.next({ request: { headers: requestHeaders } });
        for (const { name, value, options } of toSet) res.cookies.set(name, value, options);
      },
    },
  });

  /*
   * Errors are deliberately not handled here.
   *
   * A failed refresh means the session is genuinely over, and the pages behind
   * this already send an unauthenticated visitor to /login with an explanation.
   * Redirecting from middleware as well would take a signed-out visitor off the
   * public marketing page too.
   */
  await supabase.auth.getUser();

  return res;
}

/*
 * Every route a signed-in person can be on, and nothing else.
 *
 * A broad matcher would put this in front of image and font requests, paying
 * for an auth round-trip on each. Listing the routes keeps it to the pages
 * where a session exists to refresh — plus the root, which also carries the
 * magic-link rescue above.
 */
export const config = {
  matcher: ['/', '/app/:path*', '/onboarding/:path*', '/admin/:path*', '/login'],
};
