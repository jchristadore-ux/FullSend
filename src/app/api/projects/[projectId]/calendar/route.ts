import { z } from 'zod';
import { projectRoute } from '@/lib/api/handler';
import { db } from '@/lib/db/repo';
import { calendar, queueDepth, reschedule, unschedule } from '@/lib/scheduler/schedule';
import { svgDataUri } from '@/lib/creative/render';
import { CALENDAR_WINDOWS } from '@/lib/scheduler/schedule';

export const runtime = 'nodejs';

export const GET = projectRoute(async ({ session, project, req }) => {
  const daysParam = Number(new URL(req.url).searchParams.get('days') ?? 30);
  const days = (CALENDAR_WINDOWS as readonly number[]).includes(daysParam) ? daysParam : 30;

  const entries = await calendar(session.scope, project.id, days);
  const runway = await queueDepth(session.scope, project.id);

  const withPreview = await Promise.all(
    entries.map(async (e) => {
      const asset = await db().findOne(session.scope, 'creative_assets', {
        where: { project_id: project.id, content_item_id: e.content.id },
      });
      return {
        ...e,
        preview: asset ? (asset.url ?? (asset.svg ? svgDataUri(asset.svg) : null)) : null,
      };
    }),
  );

  return { days, windows: CALENDAR_WINDOWS, entries: withPreview, runway };
});

/** Move or remove a scheduled post. */
export const PATCH = projectRoute(
  async ({ session, body }) => {
    if (body.action === 'unschedule') {
      await unschedule(session.scope, body.scheduledPostId);
      return { unscheduled: true };
    }
    const post = await reschedule(
      session.scope,
      body.scheduledPostId,
      new Date(body.scheduledFor!),
    );
    return { scheduledPost: post };
  },
  {
    schema: z
      .object({
        scheduledPostId: z.string().min(1),
        action: z.enum(['reschedule', 'unschedule']),
        scheduledFor: z.string().datetime().optional(),
      })
      .refine((v) => v.action !== 'reschedule' || Boolean(v.scheduledFor), {
        message: 'scheduledFor is required when rescheduling',
        path: ['scheduledFor'],
      }),
  },
);
