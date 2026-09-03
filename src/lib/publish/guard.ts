/**
 * The cross-project guard.
 *
 * One engine drives several products. AfterIDo, PlayPal and FlipPulse each
 * have their own repository, their own brand, their own audience and their own
 * Instagram account — and the one failure none of them can absorb is a post
 * from one appearing on another's feed. It cannot be retracted, it is visible
 * to that product's actual followers, and it is the kind of mistake that is
 * noticed by everyone except the person who made it.
 *
 * So publishing is gated on proof rather than on assumption. Every row
 * involved in a publish carries `project_id`, and this checks that all of them
 * agree before anything reaches Instagram. It fails closed: an answer it
 * cannot establish is a refusal, never a default.
 *
 * Two things it defends that are easy to miss:
 *
 *  - **The destination is pinned, not re-resolved.** The publisher used to ask
 *    "which Instagram account does this project have?" at publish time. That
 *    is a different question from "which account was this post scheduled to",
 *    and the two diverge the moment a founder reconnects a project to a real
 *    account: everything already queued silently retargets. A scheduled post
 *    now records the account it is for and is published to that account or not
 *    at all.
 *
 *  - **A content item is checked against the post, not trusted from it.**
 *    Background work runs under the system scope, which crosses projects by
 *    design — that is what lets one worker serve every founder. It also means
 *    a mismatched `content_item_id` would be fetched perfectly happily. The
 *    tenant scope cannot catch this; only an explicit comparison can.
 */
import 'server-only';
import { type TenantScope } from '../db';
import { db } from '../db/repo';
import { FullSendError } from '../errors';
import { logger } from '../logger';
import type {
  BrandProfile,
  ContentItem,
  Platform,
  Project,
  ScheduledPost,
  SocialAccount,
} from '../types';

const log = logger('publish.guard');

export interface PublishTarget {
  project: Project;
  content: ContentItem;
  post: ScheduledPost;
  account: SocialAccount;
  brand: BrandProfile | null;
}

/**
 * Refusal to publish, with the fix.
 *
 * `retryable: false` throughout. Every failure here is a misconfiguration or a
 * data mismatch; retrying it produces the same answer, and a retry loop around
 * a cross-project mismatch is a loop that eventually gets lucky.
 */
function refuse(message: string, remedy: string): FullSendError {
  return new FullSendError('cross_project_block', message, {
    status: 409,
    retryable: false,
    remedy,
    meta: { crossProject: true },
  });
}

/**
 * Everything that must be true before a post reaches a platform.
 *
 * Ordered so the first thing a founder is told is the thing they can act on:
 * a missing connection is a button to press, where a project mismatch is a
 * support conversation. Each check names the project by its own name rather
 * than by id — the person reading this has three products, not three UUIDs.
 */
export async function assertPublishable(
  scope: TenantScope,
  input: { post: ScheduledPost; project: Project; content: ContentItem },
): Promise<PublishTarget> {
  const { post, project, content } = input;

  // 1. The content belongs to this project.
  if (content.project_id !== post.project_id) {
    log.error('blocked a cross-project publish', {
      postProject: post.project_id,
      contentProject: content.project_id,
      postId: post.id,
    });
    throw refuse(
      `This post's content belongs to a different project than the post itself`,
      'FullSend has blocked it rather than publish one project’s content to another’s account. ' +
        'Delete this scheduled post and re-schedule the content from its own project.',
    );
  }

  // 2. The post belongs to the project we resolved.
  if (post.project_id !== project.id) {
    throw refuse(
      `This scheduled post does not belong to ${project.name}`,
      'FullSend has blocked it. Re-schedule the post from the project that owns it.',
    );
  }

  // 3. The platform the content was written for is the platform being published to.
  if (content.platform !== post.platform) {
    throw refuse(
      `This content was written for ${content.platform} but is scheduled to publish to ${post.platform}`,
      'Re-schedule it to the platform it was written for, or regenerate it for this one.',
    );
  }

  // 4. The post is actually finished. Copy without creative is not a post,
  //    and publishing one puts an empty image on a real feed. The scheduler
  //    already refuses these; this is the check on the last path to Instagram.
  if (content.generation_state === 'failed') {
    throw refuse(
      `The creative for this post was never produced: ${content.generation_error ?? 'unknown reason'}`,
      'Regenerate the creative from the post, or delete it. FullSend will not publish a post with no visual.',
    );
  }

  // 5. A destination account, resolved once and thereafter binding.
  const account = await resolveDestination(scope, post, project);

  // 6. The account belongs to this project. The database's own
  //    unique (project_id, platform) makes this hard to violate, which is
  //    exactly why it is worth asserting: the check is cheap and the failure
  //    it catches is unrecoverable.
  if (account.project_id !== project.id) {
    log.error('blocked a publish to another project’s account', {
      postId: post.id,
      project: project.id,
      accountProject: account.project_id,
    });
    throw refuse(
      `The destination account is not connected to ${project.name}`,
      'FullSend has blocked it rather than publish to another project’s account. ' +
        `Reconnect ${post.platform} under ${project.name} → Accounts.`,
    );
  }

  if (account.platform !== post.platform) {
    throw refuse(
      `The destination account is a ${account.platform} account, but this post is for ${post.platform}`,
      `Connect a ${post.platform} account to ${project.name}.`,
    );
  }

  // 7. The account is usable. A disconnected destination is a held post, not a
  //    reason to fall back to some other account.
  if (account.status === 'disconnected') {
    throw refuse(
      `${project.name}'s ${post.platform} account (@${account.username}) is disconnected`,
      `Reconnect it under ${project.name} → Accounts. Everything already queued goes out on its own once you do.`,
    );
  }

  // 8. The brand this content was generated in. A missing profile does not
  //    block publishing — the copy is already written and already passed
  //    quality control — but it is returned so the caller can record which
  //    brand a post went out under.
  const brand = await db().findOne(scope, 'brand_profiles', {
    where: { project_id: project.id },
  });
  if (brand && brand.project_id !== project.id) {
    throw refuse(
      `The brand profile resolved for this post belongs to a different project`,
      'FullSend has blocked it. Re-run Brand for this project.',
    );
  }

  return { project, content, post, account, brand };
}

/**
 * The account a post publishes to.
 *
 * A post that already names one is published to that one, full stop — even if
 * the project has since connected a different account, and even if the named
 * one is now unhealthy. That is the guarantee: a scheduled post's destination
 * is decided when it is scheduled, and reconnecting an account later cannot
 * move work that was already queued somewhere else.
 *
 * A post with no account named is one scheduled before the destination was
 * pinned, or one scheduled while nothing was connected. It resolves the
 * project's account now and the caller writes it back, so the same post can
 * never resolve differently twice.
 */
async function resolveDestination(
  scope: TenantScope,
  post: ScheduledPost,
  project: Project,
): Promise<SocialAccount> {
  if (post.social_account_id) {
    const pinned = await db().get(scope, 'social_accounts', post.social_account_id);
    if (!pinned) {
      throw refuse(
        `The account this post was scheduled to publish to no longer exists`,
        `Reconnect ${post.platform} under ${project.name} → Accounts, then retry this post. ` +
          'FullSend will not silently send it to a different account.',
      );
    }
    return pinned;
  }

  const account = await db().findOne(scope, 'social_accounts', {
    where: { project_id: project.id, platform: post.platform },
  });
  if (!account) {
    throw refuse(
      `${project.name} has no ${post.platform} account connected`,
      `Connect ${post.platform} under ${project.name} → Accounts. A project can only ever publish ` +
        'to its own accounts, so there is no fallback for FullSend to use.',
    );
  }
  return account;
}

/**
 * Records the destination on the post, so this decision is made once.
 *
 * Called after the guard passes and before the platform is asked to do
 * anything. From here on the post has a destination in the database, and every
 * later attempt — a retry, a recovery, a run months from now — publishes to
 * that account or refuses.
 */
export async function pinDestination(
  scope: TenantScope,
  post: ScheduledPost,
  account: SocialAccount,
): Promise<void> {
  if (post.social_account_id === account.id) return;
  await db().update(scope, 'scheduled_posts', post.id, { social_account_id: account.id });
  log.info('destination pinned', {
    postId: post.id,
    project: post.project_id,
    account: account.id,
    username: account.username,
  });
}
