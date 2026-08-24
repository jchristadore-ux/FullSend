import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { db } from '@/lib/db/repo';
import { svgDataUri } from '@/lib/creative/render';
import { ContentDetail } from '@/components/app/ContentDetail';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Post' };

export default async function ContentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;

  const item = await db().get(session.scope, 'content_items', id);
  if (!item) notFound();

  const project = await db().get(session.scope, 'projects', item.project_id);
  if (!project) redirect('/app');

  const [assets, scheduled, published, campaign, pillar, persona] = await Promise.all([
    db().find(session.scope, 'creative_assets', {
      where: { project_id: item.project_id, content_item_id: item.id },
    }),
    db().findOne(session.scope, 'scheduled_posts', { where: { content_item_id: item.id } }),
    db().findOne(session.scope, 'published_posts', { where: { content_item_id: item.id } }),
    item.campaign_id ? db().get(session.scope, 'campaigns', item.campaign_id) : null,
    item.pillar_id ? db().get(session.scope, 'content_pillars', item.pillar_id) : null,
    item.persona_id ? db().get(session.scope, 'personas', item.persona_id) : null,
  ]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-8 sm:py-10">
      <Link href="/app/content" className="btn-quiet text-xs">
        ← All content
      </Link>

      <ContentDetail
        item={item}
        creative={assets.map((a) => ({
          id: a.id,
          kind: a.kind,
          source: a.source,
          width: a.width,
          height: a.height,
          alt: a.alt_text,
          src: a.url ?? (a.svg ? svgDataUri(a.svg) : null),
        }))}
        scheduled={scheduled}
        published={published}
        context={{
          campaign: campaign?.name ?? null,
          pillar: pillar?.name ?? null,
          persona: persona?.name ?? null,
          timezone: project.timezone,
        }}
      />
    </div>
  );
}
