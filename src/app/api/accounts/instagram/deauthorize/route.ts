/**
 * Meta's deauthorize callback.
 *
 * Fired when someone removes FullSend from their Instagram account. Meta does
 * not wait for a useful body — it wants a 200 — but the point is what happens
 * before that: the stored token is destroyed on our side too, rather than
 * sitting encrypted in the database until it expires on its own.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { parseSignedRequest } from '@/lib/social/signed-request';
import { revokeInstagramFor } from '@/lib/social/meta-callbacks';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = logger('instagram-deauthorize');

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!env.meta.appSecret) {
    // Nothing can be verified without it, so nothing is acted on.
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  const form = await req.formData().catch(() => null);
  const raw = form?.get('signed_request');
  if (typeof raw !== 'string') {
    return NextResponse.json({ error: 'missing_signed_request' }, { status: 400 });
  }

  const payload = parseSignedRequest(raw, env.meta.appSecret);
  if (!payload?.user_id) {
    log.warn('rejected an unverified deauthorize callback');
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  await revokeInstagramFor(String(payload.user_id));
  return NextResponse.json({ ok: true });
}
