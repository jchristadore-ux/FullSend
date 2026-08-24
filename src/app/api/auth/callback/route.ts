import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { getSupabaseServerClient, supabaseConfigured } from '@/lib/auth/session';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const log = logger('auth-callback');

/** Exchanges the magic-link code for a session cookie. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const code = req.nextUrl.searchParams.get('code');
  const nextParam = req.nextUrl.searchParams.get('next') ?? '/app';
  const next = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/app';

  if (!supabaseConfigured() || !code) {
    return NextResponse.redirect(`${env.appUrl}/login?error=Sign-in%20link%20was%20invalid`);
  }

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    log.warn('magic link exchange failed', { error: error.message });
    return NextResponse.redirect(
      `${env.appUrl}/login?error=${encodeURIComponent('That sign-in link has expired. Request a new one.')}`,
    );
  }

  return NextResponse.redirect(`${env.appUrl}${next}`);
}
