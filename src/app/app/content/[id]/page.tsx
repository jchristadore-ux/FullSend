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

  const [assets, scheduled, published, campaign, pillar, persona, brand] = await Promise.all([
    db().find(session.scope, 'creative_assets', {
      where: { project_id: item.project_id, content_item_id: item.id },
    }),
    db().findOne(session.scope, 'scheduled_posts', { where: { content_item_id: item.id } }),
    db().findOne(session.scope, 'published_posts', { where: { content_item_id: item.id } }),
    item.campaign_id ? db().get(session.scope, 'campaigns', item.campaign_id) : null,
    item.pillar_id ? db().get(session.scope, 'content_pillars', item.pillar_id) : null,
    item.persona_id ? db().get(session.scope, 'personas', item.persona_id) : null,
    db().findOne(session.scope, 'brand_profiles', { where: { project_id: item.project_id } }),
  ]);

  /*
   * The account this post will actually publish to.
   *
   * The scheduled post's own pinned account when it has one — that is binding,
   * and reconnecting the project later cannot move it. Otherwise the project's
   * current account, which is what the post would be pinned to on its first
   * publish attempt.
   */
  const destination = scheduled?.social_account_id
    ? await db().get(session.scope, 'social_accounts', scheduled.social_account_id)
    : await db().findOne(session.scope, 'social_accounts', {
        where: { project_id: item.project_id, platform: item.platform },
      });

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
          project: project.name,
          brand: brand?.brand_name || (brand ? project.name : null),
          destination: destination && destination.status !== 'disconnected' ? destination.username : null,
        }}
      />
    </div>
  );
}
