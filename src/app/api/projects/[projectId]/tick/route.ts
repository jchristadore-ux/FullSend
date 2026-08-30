import { NextResponse } from 'next/server';
import { projectRoute } from '@/lib/api/handler';
import { drainQueue } from '@/lib/jobs/runner';

export const runtime = 'nodejs';
// FullSend's free Vercel deployment is capped at 60s. Process exactly one
// durable job per tick so every AI stage gets its own invocation.
export const maxDuration = 60;

export const POST = projectRoute(async ({ project }) => {
  // Do not use after(): on Hobby/free deployments it can still be terminated
  // with the function and leave a claimed job looking stalled. The onboarding
  // client polls this endpoint, so one foreground job per poll is reliable.
  const result = await drainQueue({ max: 1, budgetMs: 52_000, projectId: project.id });
  return NextResponse.json({ ok: true, ...result });
});
