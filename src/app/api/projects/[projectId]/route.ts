import { projectRoute } from '@/lib/api/handler';
import { settingsInput } from '@/lib/schemas';
import { audit, db, getSettings, updateProject } from '@/lib/db/repo';
import { nowIso } from '@/lib/ids';

export const runtime = 'nodejs';

export const GET = projectRoute(async ({ session, project }) => {
  const settings = await getSettings(session.scope, project.id);
  return { project, settings };
});

export const PATCH = projectRoute(
  async ({ session, project, body }) => {
    const projectPatch: Record<string, unknown> = {};
    if (body.autopilot_mode) projectPatch.autopilot_mode = body.autopilot_mode;
    if (body.timezone) projectPatch.timezone = body.timezone;

    const updated = Object.keys(projectPatch).length
      ? await updateProject(session.scope, project.id, projectPatch)
      : project;

    const settingsPatch: Record<string, unknown> = { updated_at: nowIso() };
    for (const key of [
      'daily_post_cap',
      'require_approval_for_promotion',
      'trend_participation',
      'notify_email',
      'quiet_hours',
    ] as const) {
      if (body[key] !== undefined) settingsPatch[key] = body[key];
    }

    const existing = await getSettings(session.scope, project.id);
    const settings =
      existing && Object.keys(settingsPatch).length > 1
        ? await db().update(session.scope, 'settings', existing.id, settingsPatch)
        : existing;

    await audit(session.scope, {
      user_id: session.user.id,
      project_id: project.id,
      action: 'project.settings_updated',
      target: project.id,
      metadata: { ...projectPatch, ...settingsPatch },
      ip: null,
    });

    return { project: updated, settings };
  },
  { schema: settingsInput },
);

export const DELETE = projectRoute(async ({ session, project }) => {
  await audit(session.scope, {
    user_id: session.user.id,
    project_id: project.id,
    action: 'project.deleted',
    target: project.name,
    metadata: {},
    ip: null,
  });
  await db().remove(session.scope, 'projects', project.id);
  return { deleted: true };
});
