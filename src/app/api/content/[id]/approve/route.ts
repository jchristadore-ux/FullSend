import { LIMITS, route } from '@/lib/api/handler';
import { z } from 'zod';
import { audit, db, getProject } from '@/lib/db/repo';
import { FullSendError, notFound } from '@/lib/errors';
import { nowIso } from '@/lib/ids';
import { publishScheduledPost } from '@/lib/publish/publish';
import { scheduleContent } from '@/lib/scheduler/schedule';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Approve, and optionally send it right now. This is the "DO IT" button —
 * one click from a held post to live.
 */
export const POST = route(
  async ({ session, params, body }) => {
    const item = await db().get(session.scope, 'content_items', params.id);
    if (!item) throw notFound('Content');

    const project = await getProject(session.scope, item.project_id);
    if (!project) throw notFound('Project');

    if (item.qc && !item.qc.passed && !body.override) {
      throw new FullSendError(
        'qc_blocked',
        'Quality control blocked this post',
        {
          status: 409,
          remedy:
            'Fix the flagged issue, or approve with override if you have checked it yourself.',
          meta: { findings: item.qc.findings.filter((f) => f.severity === 'block') },
        },
      );
    }

    const approved = await db().update(session.scope, 'content_items', item.id, {
      status: 'approved',
      updated_at: nowIso(),
    });

    await audit(session.scope, {
      user_id: session.user.id,
      project_id: item.project_id,
      action: body.override ? 'content.approved_with_override' : 'content.approved',
      target: item.id,
      metadata: { publishNow: Boolean(body.publishNow) },
      ip: null,
    });

    const { scheduled } = await scheduleContent(session.scope, project, [approved]);
    const scheduledPost =
      scheduled[0] ??
      (await db().findOne(session.scope, 'scheduled_posts', {
        where: { content_item_id: item.id },
      }));

    if (body.publishNow && scheduledPost) {
      const outcome = await publishScheduledPost(session.scope, scheduledPost.id);
      return { content: approved, published: outcome };
    }

    return { content: approved, scheduled: scheduledPost };
  },
  {
    schema: z.object({
      publishNow: z.boolean().default(false),
      override: z.boolean().default(false),
    }),
    rateLimit: LIMITS.publishManual,
    rateLimitKey: 'approve',
  },
);
