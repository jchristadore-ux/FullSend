import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { cronSecretValid } from '@/lib/jobs/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  // Unauthenticated: liveness only. Full configuration detail requires CRON_SECRET.
  if (!cronSecretValid(req.headers.get('authorization'))) {
    return NextResponse.json(
      { ok: true, appUrl: env.appUrl },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const { buildFullHealthReport } = await import('@/lib/health/report');
  const body = await buildFullHealthReport();
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
