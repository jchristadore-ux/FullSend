/**
 * Meta App Review readiness.
 *
 * Public on purpose: Meta and the operator need to confirm redirect URIs,
 * callback URLs, scopes and media-domain notes without a cron secret. Only
 * presence flags and expected public URLs are returned — never App ID, App
 * Secret, webhook tokens, or any other secret.
 */
import { NextResponse } from 'next/server';
import { metaReadiness } from '@/lib/social/meta-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const meta = metaReadiness();
  return NextResponse.json(
    {
      ok: meta.configured && meta.reviewNotes.length === 0,
      meta,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
