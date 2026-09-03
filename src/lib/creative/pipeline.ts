/**
 * The creative half of making a post, and the state that says whether it
 * worked.
 *
 * Copy and creative used to be one unbroken sequence inside content
 * generation: write the post, render the cards, save. If the render threw, the
 * post was already in the database — with an empty `creative_asset_ids`, an
 * ordinary status, and nothing anywhere recording that half of it was never
 * made. The calendar then scheduled it, the grid drew an empty box above the
 * copy, and every count in the product called it a success.
 *
 * So the render is its own step here, with its own state, and it has exactly
 * three outcomes: creative exists, creative failed and the post says so, or
 * the whole thing throws. There is no fourth outcome where a post quietly has
 * no pictures.
 */
import 'server-only';
import { type TenantScope } from '../db';
import { db, notify, recordError } from '../db/repo';
import { isFullSendError } from '../errors';
import { nowIso } from '../ids';
import { logger } from '../logger';
import { renderCreative } from './render';
import type {
  BrandProfile,
  ContentItem,
  CreativeAsset,
  GenerationState,
  ProductAnalysis,
  Project,
  Uuid,
} from '../types';

const log = logger('creative.pipeline');

export interface MaterializeResult {
  item: ContentItem;
  assets: CreativeAsset[];
  failed: boolean;
  error: string | null;
}

/**
 * Renders a post's creative and records what happened on the post itself.
 *
 * `brand` and `analysis` are passed in rather than looked up, because both
 * callers already hold the ones belonging to this project — and re-resolving
 * them here is exactly how one brand's colours end up on another brand's card.
 * The project match is asserted rather than assumed: it is one comparison, and
 * the failure it prevents is a post published in the wrong product's identity.
 */
export async function materializeCreative(
  scope: TenantScope,
  input: {
    project: Project;
    item: ContentItem;
    brand: BrandProfile;
    analysis: ProductAnalysis;
  },
): Promise<MaterializeResult> {
  const { project, item, brand, analysis } = input;

  if (brand.project_id !== project.id || analysis.project_id !== project.id) {
    // Fail closed. A mismatched brand is not a rendering problem to work
    // around; it is somebody else's identity about to be printed on this card.
    const message = `The brand profile handed to creative generation belongs to a different project`;
    log.error('blocked cross-project creative', {
      project: project.id,
      brandProject: brand.project_id,
      analysisProject: analysis.project_id,
    });
    return failed(scope, item, message);
  }
  if (item.project_id !== project.id) {
    return failed(scope, item, `This post does not belong to ${project.name}`);
  }

  await setState(scope, item, 'generating_creative', null);

  try {
    const assets = await renderCreative(scope, { project, item, brand, analysis });
    if (assets.length === 0) {
      return failed(
        scope,
        item,
        'The creative renderer produced no images for this post',
      );
    }

    const ids = assets.map((a) => a.id);
    const updated = await db().update(scope, 'content_items', item.id, {
      creative_asset_ids: ids,
      generation_state: 'complete' satisfies GenerationState,
      generation_error: null,
      updated_at: nowIso(),
    });

    log.info('creative materialized', {
      project: project.id,
      item: item.id,
      assets: ids.length,
    });
    return { item: updated, assets, failed: false, error: null };
  } catch (e) {
    const message = isFullSendError(e)
      ? `${e.message}${e.remedy ? ` — ${e.remedy}` : ''}`
      : e instanceof Error
        ? e.message
        : String(e);
    log.error('creative generation failed', { project: project.id, item: item.id, error: message });
    return failed(scope, item, message);
  }
}

/**
 * A post whose creative failed is held, not scheduled.
 *
 * `review_required` rather than `failed`: the copy is real and worth keeping,
 * and the founder can regenerate the creative or rewrite the post. What it must
 * never be is `approved`, because approved is what the scheduler acts on.
 */
async function failed(
  scope: TenantScope,
  item: ContentItem,
  message: string,
): Promise<MaterializeResult> {
  const updated = await db().update(scope, 'content_items', item.id, {
    generation_state: 'failed' satisfies GenerationState,
    generation_error: message,
    status: item.status === 'published' ? item.status : 'review_required',
    updated_at: nowIso(),
  });

  /*
   * Recorded where the Control Room looks, not only on the post.
   *
   * Every route into this function is a failure somebody has to act on, and a
   * failure that exists only as a field on one row out of three hundred is a
   * failure nobody finds. One record, one place, whatever went wrong.
   */
  await recordError(scope, {
    projectId: item.project_id,
    scope: `creative:${item.id}`,
    message,
    remedy: 'Regenerate the creative for this post from the post page.',
  });

  return { item: updated, assets: [], failed: true, error: message };
}

async function setState(
  scope: TenantScope,
  item: ContentItem,
  state: GenerationState,
  error: string | null,
): Promise<void> {
  await db().update(scope, 'content_items', item.id, {
    generation_state: state,
    generation_error: error,
    updated_at: nowIso(),
  });
}

/**
 * Re-renders one post's creative — the retry behind the "generate creative"
 * job and the button on the post page.
 *
 * Existing assets are removed first. Leaving them would double a carousel on
 * every retry, and keeping a blank card beside a good one is how a blank card
 * gets published.
 */
export async function regenerateCreative(
  scope: TenantScope,
  itemId: Uuid,
): Promise<MaterializeResult> {
  const item = await db().get(scope, 'content_items', itemId);
  if (!item) throw new Error('Content item not found');

  const project = await db().get(scope, 'projects', item.project_id);
  if (!project) throw new Error('Project not found');

  const [brand, analysis] = await Promise.all([
    db().findOne(scope, 'brand_profiles', { where: { project_id: item.project_id } }),
    db().findOne(scope, 'product_analysis', {
      where: { project_id: item.project_id },
      orderBy: 'created_at',
      direction: 'desc',
    }),
  ]);
  if (!brand || !analysis) {
    return failed(
      scope,
      item,
      'This project has no brand profile or product analysis yet, so there is nothing to draw from',
    );
  }

  const existing = await db().find(scope, 'creative_assets', {
    where: { project_id: item.project_id, content_item_id: item.id },
  });
  for (const asset of existing) await db().remove(scope, 'creative_assets', asset.id);

  return materializeCreative(scope, { project, item, brand, analysis });
}

/**
 * Tells the founder once that creative is failing, rather than once per post.
 *
 * A creative failure is almost always systemic — a renderer that cannot draw
 * text, storage that is not configured — so the batch reports it as one thing
 * that is wrong, with the number of posts it is holding.
 */
export async function notifyCreativeFailures(
  scope: TenantScope,
  project: Project,
  failures: string[],
): Promise<void> {
  if (failures.length === 0) return;
  const reason = failures[0];
  await notify(scope, {
    user_id: project.user_id,
    project_id: project.id,
    severity: 'error',
    title: `${failures.length} post${failures.length === 1 ? '' : 's'} ${failures.length === 1 ? 'has' : 'have'} no creative`,
    body:
      `The copy was written but the visual could not be produced: ${reason} ` +
      'FullSend is holding these rather than publishing an empty image.',
    action_label: 'See what is held',
    action_href: '/app/content?status=review_required',
  });
}
