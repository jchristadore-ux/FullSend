import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { DEV_SESSION_COOKIE, getSupabaseServerClient, supabaseConfigured } from '@/lib/auth/session';

export const runtime = 'nodejs';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  if (supabaseConfigured()) {
    const supabase = await getSupabaseServerClient();
    await supabase.auth.signOut();
  }
  const response = NextResponse.json({ ok: true, next: '/' });
  response.cookies.delete(DEV_SESSION_COOKIE);
  response.cookies.delete('fs_project');
  void env;
  return response;
}
