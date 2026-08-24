import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/lib/api/handler';
import { check, LIMITS } from '@/lib/rate-limit';
import { env } from '@/lib/env';
import { badRequest, FullSendError } from '@/lib/errors';
import {
  createDevSession,
  devAuthAvailable,
  getSupabaseServerClient,
  supabaseConfigured,
} from '@/lib/auth/session';
import { audit } from '@/lib/db/repo';
import { systemScope } from '@/lib/db';

export const runtime = 'nodejs';

const input = z.object({
  email: z.string().email().max(200),
  next: z.string().max(200).default('/app'),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // Rate limited by IP: sign-in is unauthenticated by definition.
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('x-real-ip') ??
      'unknown';
    check(`signin:${ip}`, LIMITS.authAttempt);

    const parsed = input.safeParse(await req.json());
    if (!parsed.success) throw badRequest('Enter a valid email address');
    const { email, next } = parsed.data;

    // Only same-origin paths — an open redirect here is a phishing vector.
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/app';

    if (supabaseConfigured()) {
      const supabase = await getSupabaseServerClient();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${env.appUrl}/api/auth/callback?next=${encodeURIComponent(safeNext)}` },
      });
      if (error) {
        throw new FullSendError('auth_failed', error.message, {
          status: 400,
          remedy: 'Check the address and try again.',
        });
      }
      return NextResponse.json({ magicLink: true });
    }

    if (!devAuthAvailable()) {
      throw new FullSendError('auth_not_configured', 'Authentication is not configured', {
        status: 503,
        remedy: 'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
      });
    }

    const session = await createDevSession(email);
    await audit(systemScope('dev sign-in'), {
      user_id: session.user.id,
      project_id: null,
      action: 'auth.dev_signin',
      target: email,
      metadata: {},
      ip,
    });

    const response = NextResponse.json({ magicLink: false, next: safeNext });
    response.cookies.set(session.cookieName, session.cookieValue, {
      httpOnly: true,
      secure: env.nodeEnv === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: session.maxAge,
    });
    return response;
  } catch (e) {
    return errorResponse(e, req);
  }
}
