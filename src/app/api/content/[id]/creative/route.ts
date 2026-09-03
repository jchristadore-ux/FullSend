import { route } from '@/lib/api/handler';
import { audit, db } from '@/lib/db/repo';
import { FullSendError, notFound } from '@/lib/errors';
import { regenerateCreative } from '@/lib/creative/pipeline';
import { LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Re-render one post's creative.
 *
 * The way back from a failed render. Creative generation now records a real
 * failure on the post instead of leaving an empty card that looks finished —
 * which is only half a fix, because a founder looking at "creative failed"
 * needs something to press. This is that something, and it is the same code
 * path content generation uses, so a post recovered here is identical to one
 * that worked first time.
 */
export const POST = route(
  async ({ session, params }) => {
    const item = await db().get(session.scope, 'content_items', params.id);
    if (!item) throw notFound('Content');

    /*
     * A published post keeps the creative it published with.
     *
     * Regenerating replaces the assets, and for a post that is already on
     * Instagram those rows are the only record of what actually went out.
     * Nothing on the platform changes either way, so this would trade a real
     * receipt for a picture nobody will see.
     */
    if (item.status === 'published') {
      throw new FullSendError('already_published', 'This post has already gone out', {
        status: 409,
        remedy:
          'Its creative is the record of what was published. Generate a new post if you want a ' +
          'different image on the feed.',
      });
    }

    const outcome = await regenerateCreative(session.scope, item.id);

    await audit(session.scope, {
      user_id: session.user.id,
      project_id: item.project_id,
      action: 'creative.regenerated',
      target: item.id,
      metadata: { assets: outcome.assets.length, failed: outcome.failed },
      ip: null,
    });

    return {
      content: outcome.item,
      assets: outcome.assets.length,
      failed: outcome.failed,
      // Returned rather than thrown: the post is still there, still has its
      // copy, and the founder is looking at the reason on the same screen.
      error: outcome.error,
    };
  },
  { rateLimit: LIMITS.generateContent, rateLimitKey: 'creative' },
);
