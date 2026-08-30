import { after } from 'next/server';
import { NextResponse } from 'next/server';
import { projectRoute } from '@/lib/api/handler';
import { drainQueue } from '@/lib/jobs/runner';

export const runtime = 'nodejs';
export const maxDuration = 300;

export const POST = projectRoute(async ({ project }) => {
  after(async () => {
    try {
      await drainQueue({ max: 8, budgetMs: 240_000, projectId: project.id });
    } catch {
      // Durable job state records the failure; the HTTP response is already sent.
    }
  });
  return NextResponse.json({ ok: true, queued: true });
});
