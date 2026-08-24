import { z } from 'zod';
import { projectRoute } from '@/lib/api/handler';
import { db, enqueue, listRecommendations } from '@/lib/db/repo';
import { notFound } from '@/lib/errors';
import { applyRecommendation, dismissRecommendation } from '@/lib/optimizer/optimize';
import { topUpContent } from '@/lib/automation/autopilot';

export const runtime = 'nodejs';
export const maxDuration = 60;

export const GET = projectRoute(async ({ session, project }) => {
  const recommendations = await listRecommendations(session.scope, project.id);
  const experiments = await db().find(session.scope, 'experiments', {
    where: { project_id: project.id },
    orderBy: 'created_at',
    direction: 'desc',
    limit: 20,
  });
  return { recommendations, experiments };
});

/**
 * "DO IT" / "CHANGE IT" — the two buttons on FullSend's next move.
 * Applying a `generate_content` recommendation actually generates the content.
 */
export const POST = projectRoute(
  async ({ session, project, body }) => {
    const rec = await db().get(session.scope, 'recommendations', body.recommendationId);
    if (!rec || rec.project_id !== project.id) throw notFound('Recommendation');

    if (body.action === 'dismiss') {
      return { recommendation: await dismissRecommendation(session.scope, rec.id) };
    }

    const applied = await applyRecommendation(session.scope, project, rec, false);

    if (rec.action.type === 'generate_content') {
      const result = await topUpContent(session.scope, project, 14, rec.action.brief, 'optimizer');
      return {
        recommendation: await db().get(session.scope, 'recommendations', rec.id),
        applied,
        generated: result.generated,
      };
    }

    // A mix or cadence change only shows up once new content is planned against it.
    const job = await enqueue(
      session.scope,
      'generate_content',
      { projectId: project.id, days: 14, origin: 'optimizer' },
      { projectId: project.id },
    );

    return {
      recommendation: await db().get(session.scope, 'recommendations', rec.id),
      applied,
      jobId: job.id,
    };
  },
  {
    schema: z.object({
      recommendationId: z.string().min(1),
      action: z.enum(['apply', 'dismiss']),
    }),
  },
);

/** Re-run the optimizer on demand. */
export const PUT = projectRoute(async ({ session, project }) => {
  const job = await enqueue(
    session.scope,
    'optimize',
    { projectId: project.id },
    { projectId: project.id },
  );
  return { jobId: job.id };
});
