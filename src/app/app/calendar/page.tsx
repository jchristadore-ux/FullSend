import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { activeProject } from '@/lib/active-project';
import { calendar, CALENDAR_WINDOWS, queueDepth } from '@/lib/scheduler/schedule';
import { db } from '@/lib/db/repo';
import { svgDataUri } from '@/lib/creative/render';
import { CalendarBoard } from '@/components/app/CalendarBoard';
import { generationBlocker } from '@/lib/automation/autopilot';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Content Calendar' };

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await requireSession();
  const project = await activeProject(session);
  if (!project) redirect('/onboarding');

  const params = await searchParams;
  const requested = Number(params.days ?? 30);
  const days = (CALENDAR_WINDOWS as readonly number[]).includes(requested) ? requested : 30;

  const entries = await calendar(session.scope, project.id, days);
  const runway = await queueDepth(session.scope, project.id);
  // Read before rendering, so an empty calendar explains itself rather than
  // offering a button that cannot do what it says.
  const blocked = await generationBlocker(session.scope, project);

  const withPreview = await Promise.all(
    entries.map(async (e) => {
      const asset = await db().findOne(session.scope, 'creative_assets', {
        where: { project_id: project.id, content_item_id: e.content.id },
      });
      return {
        id: e.scheduledPost.id,
        contentId: e.content.id,
        scheduledFor: e.scheduledPost.scheduled_for,
        status: e.scheduledPost.status,
        platform: e.content.platform,
        format: e.content.format,
        hook: e.content.hook,
        lastError: e.scheduledPost.last_error,
        attempts: e.scheduledPost.attempts,
        preview: asset ? (asset.url ?? (asset.svg ? svgDataUri(asset.svg) : null)) : null,
      };
    }),
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="label">Content Calendar</span>
          <h1 className="mt-2 font-display text-3xl font-extrabold tracking-crush text-mist sm:text-4xl">
            The next {days} days.
          </h1>
          <p className="mt-2 font-mono text-xs text-dimmer">
            {runway.queued} queued · {runway.daysOfRunway} days of runway
          </p>
        </div>
      </div>

      <CalendarBoard
        projectId={project.id}
        timezone={project.timezone}
        days={days}
        windows={[...CALENDAR_WINDOWS]}
        entries={withPreview}
        blocked={blocked}
      />
    </div>
  );
}
