import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { activeProject } from '@/lib/active-project';
import { db, listContent } from '@/lib/db/repo';
import { svgDataUri } from '@/lib/creative/render';
import { ContentGrid } from '@/components/app/ContentGrid';
import type { ContentStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Content' };

const STATUSES: ContentStatus[] = [
  'review_required',
  'approval_required',
  'approved',
  'scheduled',
  'published',
  'failed',
  'draft',
];

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await requireSession();
  const project = await activeProject(session);
  if (!project) redirect('/onboarding');

  const params = await searchParams;
  const filter = STATUSES.includes(params.status as ContentStatus)
    ? (params.status as ContentStatus)
    : null;

  const all = await listContent(session.scope, project.id, { limit: 300 });
  const items = filter ? all.filter((i) => i.status === filter) : all;

  const counts: Record<string, number> = {};
  for (const i of all) counts[i.status] = (counts[i.status] ?? 0) + 1;

  const withCreative = await Promise.all(
    items.slice(0, 60).map(async (item) => {
      const assets = await db().find(session.scope, 'creative_assets', {
        where: { project_id: project.id, content_item_id: item.id },
      });
      return {
        id: item.id,
        hook: item.hook,
        caption: item.caption,
        cta: item.cta,
        hashtags: item.hashtags,
        platform: item.platform,
        format: item.format,
        status: item.status,
        scheduledFor: item.scheduled_for,
        origin: item.origin,
        qcPassed: item.qc?.passed ?? true,
        qcFindings:
          item.qc?.findings.filter((f) => f.severity !== 'pass').map((f) => f.message) ?? [],
        videoStatus: item.video_plan?.render_status ?? null,
        videoSeconds: item.video_plan?.total_duration_seconds ?? null,
        slides: item.slides?.length ?? 0,
        previews: assets
          .map((a) => a.url ?? (a.svg ? svgDataUri(a.svg) : null))
          .filter((x): x is string => Boolean(x)),
      };
    }),
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-10">
      <span className="label">Content</span>
      <h1 className="mt-2 font-display text-3xl font-extrabold tracking-crush text-mist sm:text-4xl">
        {all.length} post{all.length === 1 ? '' : 's'} in the machine.
      </h1>

      <ContentGrid
        items={withCreative}
        counts={counts}
        total={all.length}
        activeFilter={filter}
        statuses={STATUSES}
      />
    </div>
  );
}
