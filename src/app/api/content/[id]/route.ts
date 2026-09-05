import { route } from '@/lib/api/handler';
import { updateContentInput } from '@/lib/schemas';
import { audit, db, getAnalysis, getBrandProfile, getProject } from '@/lib/db/repo';
import { FullSendError, notFound } from '@/lib/errors';
import { nowIso } from '@/lib/ids';
import { runQualityControl } from '@/lib/qc/check';
import { reschedule, unschedule } from '@/lib/scheduler/schedule';

export const runtime = 'nodejs';

export const GET = route(async ({ session, params }) => {
  const item = await db().get(session.scope, 'content_items', params.id);
  if (!item) throw notFound('Content');

  const assets = await db().find(session.scope, 'creative_assets', {
    where: { project_id: item.project_id, content_item_id: item.id },
  });
  // Never return raw SVG markup to the client — id/kind/url/dims/alt only.
  const creative = assets.map((a) => ({
    id: a.id,
    kind: a.kind,
    url: a.url,
    width: a.width,
    height: a.height,
    alt_text: a.alt_text,
  }));
  const scheduled = await db().findOne(session.scope, 'scheduled_posts', {
    where: { content_item_id: item.id },
  });
  const published = await db().findOne(session.scope, 'published_posts', {
    where: { content_item_id: item.id },
  });

  return { content: item, creative, scheduled, published };
});

/**
 * Edits re-run quality control, so a human edit can't route around the same
 * gate the machine has to pass.
 */
export const PATCH = route(
  async ({ session, params, body }) => {
    const item = await db().get(session.scope, 'content_items', params.id);
    if (!item) throw notFound('Content');
    if (item.status === 'published') {
      throw new FullSendError('already_published', 'This post has already gone out', {
        status: 409,
        remedy: 'Published posts cannot be edited from FullSend.',
      });
    }

    const merged = { ...item, ...body };
    const [analysis, brand] = await Promise.all([
      getAnalysis(session.scope, item.project_id),
      getBrandProfile(session.scope, item.project_id),
    ]);
    const qc = runQualityControl({ item: merged, analysis, brand });

    const patch: Record<string, unknown> = { ...body, qc, updated_at: nowIso() };
    // A blocked edit is held, never silently scheduled.
    if (!qc.passed) patch.status = 'review_required';

    const updated = await db().update(session.scope, 'content_items', item.id, patch);

    if (body.scheduled_for) {
      const scheduled = await db().findOne(session.scope, 'scheduled_posts', {
        where: { content_item_id: item.id },
      });
      if (scheduled) {
        await reschedule(session.scope, scheduled.id, new Date(body.scheduled_for));
      }
    }

    await audit(session.scope, {
      user_id: session.user.id,
      project_id: item.project_id,
      action: 'content.edited',
      target: item.id,
      metadata: { fields: Object.keys(body ?? {}), qcPassed: qc.passed },
      ip: null,
    });

    return { content: updated, qc };
  },
  { schema: updateContentInput },
);

export const DELETE = route(async ({ session, params }) => {
  const item = await db().get(session.scope, 'content_items', params.id);
  if (!item) throw notFound('Content');

  const scheduled = await db().findOne(session.scope, 'scheduled_posts', {
    where: { content_item_id: item.id },
  });
  if (scheduled) await unschedule(session.scope, scheduled.id);

  await db().remove(session.scope, 'content_items', item.id);
  void getProject;
  return { deleted: true };
});
