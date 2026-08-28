/**
 * Meta's data deletion request callback.
 *
 * Meta requires a JSON response carrying a status URL and a confirmation code,
 * and it checks that the URL resolves. The deletion itself is the same work as
 * a deauthorize — the tokens and the connection go — with the difference that
 * Meta needs something to point the person at afterwards.
 *
 * The confirmation code is derived from the user id rather than random, so the
 * status page can be reached again later without storing a lookup table for
 * codes nobody ever quotes back.
 */
import crypto from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { parseSignedRequest } from '@/lib/social/signed-request';
import { revokeInstagramFor } from '@/lib/social/meta-callbacks';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = logger('instagram-data-deletion');

/** Short, stable, and not reversible into the user id. */
export function confirmationCode(externalId: string, appSecret: string): string {
  return crypto.createHmac('sha256', appSecret).update(externalId).digest('hex').slice(0, 16);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!env.meta.appSecret) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  const form = await req.formData().catch(() => null);
  const raw = form?.get('signed_request');
  if (typeof raw !== 'string') {
    return NextResponse.json({ error: 'missing_signed_request' }, { status: 400 });
  }

  const payload = parseSignedRequest(raw, env.meta.appSecret);
  if (!payload?.user_id) {
    log.warn('rejected an unverified data deletion callback');
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  const externalId = String(payload.user_id);
  await revokeInstagramFor(externalId);

  const code = confirmationCode(externalId, env.meta.appSecret);
  return NextResponse.json({
    url: `${env.appUrl.replace(/\/+$/, '')}/data-deletion?code=${code}`,
    confirmation_code: code,
  });
}
