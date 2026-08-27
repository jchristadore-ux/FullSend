/**
 * Whether the visitor is signed in.
 *
 * The landing page is static — it is marketing, it should come off a CDN, and
 * it should not cost a function call to read. That means it cannot know who is
 * looking at it, so it greeted returning founders as strangers: a "Sign in"
 * link and a button that starts a second project.
 *
 * This is the smallest thing that fixes that: a boolean, so the nav can offer
 * the Send Center instead. It decides a link's label, never access — every app
 * page still resolves the session itself.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  let signedIn = false;
  try {
    signedIn = (await getSession()) !== null;
  } catch {
    // A session that cannot be resolved is not a session. The nav falls back
    // to its signed-out links, which are never wrong — only less helpful.
  }
  return NextResponse.json({ signedIn }, { headers: { 'Cache-Control': 'no-store' } });
}
