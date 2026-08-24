import { z } from 'zod';
import { LIMITS, projectRoute } from '@/lib/api/handler';
import { generateCalendarInput } from '@/lib/schemas';
import { db, enqueue, listContent } from '@/lib/db/repo';
import { svgDataUri } from '@/lib/creative/render';
import type { ContentStatus } from '@/lib/types';

export const runtime = 'nodejs';

const statusFilter = z.enum([
  'draft',
  'approval_required',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'failed',
  'review_required',
]);

export const GET = projectRoute(async ({ session, project, req }) => {
  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status');
  const parsed = statusParam ? statusFilter.safeParse(statusParam) : null;
  const status: ContentStatus[] | undefined = parsed?.success ? [parsed.data] : undefined;

  const items = await listContent(session.scope, project.id, { status, limit: 200 });

  // Attach creative previews so the list renders without a second round-trip.
  const withCreative = await Promise.all(
    items.map(async (item) => {
      const assets = await db().find(session.scope, 'creative_assets', {
        where: { project_id: project.id, content_item_id: item.id },
      });
      return {
        ...item,
        creative: assets.map((a) => ({
          id: a.id,
          kind: a.kind,
          width: a.width,
          height: a.height,
          alt: a.alt_text,
          src: a.url ?? (a.svg ? svgDataUri(a.svg) : null),
        })),
      };
    }),
  );

  const counts: Record<string, number> = {};
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;

  return { content: withCreative, counts, total: items.length };
});

/** Generates a fresh batch for the requested window. */
export const POST = projectRoute(
  async ({ session, project, body }) => {
    const job = await enqueue(
      session.scope,
      'generate_content',
      { projectId: project.id, days: body.days, origin: 'manual' },
      { projectId: project.id },
    );
    return { jobId: job.id, status: 'queued', days: body.days };
  },
  {
    schema: generateCalendarInput,
    rateLimit: LIMITS.generateContent,
    rateLimitKey: 'generate-content',
  },
);
