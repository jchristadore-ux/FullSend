/**
 * Public no-signup demo.
 *
 * Heavily rate-limited. SSRF-safe. Never publishes. Output is the sales asset.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/lib/api/handler';
import { runDemo } from '@/lib/demo/run-demo';
import { badRequest } from '@/lib/errors';
import { check, LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const bodySchema = z.object({
  source: z.string().min(3).max(500),
});

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ip = clientIp(req);
    check(`demo:ip:${ip}`, LIMITS.demo);
    check('demo:global', LIMITS.demoGlobal);

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      throw badRequest('Paste a public GitHub repository or website URL');
    }

    const result = await runDemo(parsed.data.source);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e, req);
  }
}
