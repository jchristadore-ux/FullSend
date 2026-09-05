import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectPlatform,
  createProject,
  setupContext,
  teardown,
  type TestContext,
} from './helpers';
import { db } from '@/lib/db/repo';
import { newId, nowIso } from '@/lib/ids';
import { backoffMs, buildCaption, publishScheduledPost, resumeAfterReconnect } from '@/lib/publish/publish';
import { scheduleContent, reschedule, unschedule, nextSend, queueDepth } from '@/lib/scheduler/schedule';
import { disconnect, getUsableConnection, loadTokens } from '@/lib/social/connections';
import { encryptSecret, decryptSecret, signState, verifyState, createPkcePair } from '@/lib/crypto';
import { mapMetaError } from '@/lib/social/instagram';
import { mapTikTokError } from '@/lib/social/tiktok';
import { FullSendError } from '@/lib/errors';
import type { ContentItem, Project } from '@/lib/types';

/* ── Fixtures ───────────────────────────────────────────────────────────── */

async function makePost(
  ctx: TestContext,
  project: Project,
  overrides: Partial<ContentItem> = {},
): Promise<ContentItem> {
  const item = await db().insert(ctx.scope, 'content_items', {
    id: newId(),
    project_id: project.id,
    campaign_id: null,
    pillar_id: null,
    persona_id: null,
    platform: 'instagram',
    format: 'static',
    hook: `A reasonable hook ${newId().slice(0, 8)}`,
    script: null,
    caption: 'A caption that passes every quality control check without any trouble.',
    cta: 'Link in bio',
    hashtags: ['#productivity'],
    video_plan: null,
    slides: null,
    creative_asset_ids: [],
    generation_state: 'complete' as const,
    generation_error: null,
    status: 'approved',
    dedup_hash: newId(),
    qc: null,
    scheduled_for: nowIso(),
    published_at: null,
    origin: 'manual',
    ai_cost_usd: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  });

  const asset = await db().insert(ctx.scope, 'creative_assets', {
    id: newId(),
    project_id: project.id,
    content_item_id: item.id,
    kind: 'image',
    source: 'svg_render',
    mime_type: 'image/jpeg',
    width: 1080,
    height: 1350,
    url: 'https://cdn.example.test/a.jpg',
    storage_path: null,
    svg: null,
    alt_text: 'card',
    created_at: nowIso(),
  });

  return db().update(ctx.scope, 'content_items', item.id, {
    creative_asset_ids: [asset.id],
  });
}

/* ── Crypto & OAuth ─────────────────────────────────────────────────────── */

describe('token encryption', () => {
  it('round-trips a secret', () => {
    const secret = 'ig-token-abc123';
    const cipher = encryptSecret(secret, 'aad');
    expect(cipher).not.toContain(secret);
    expect(cipher.startsWith('v1.')).toBe(true);
    expect(decryptSecret(cipher, 'aad')).toBe(secret);
  });

  it('refuses to decrypt with the wrong context', () => {
    const cipher = encryptSecret('secret', 'project-a:account-a');
    expect(() => decryptSecret(cipher, 'project-b:account-b')).toThrow();
  });

  it('produces different ciphertext each time', () => {
    expect(encryptSecret('same', 'aad')).not.toBe(encryptSecret('same', 'aad'));
  });

  it('rejects a tampered payload', () => {
    const cipher = encryptSecret('secret', 'aad');
    const parts = cipher.split('.');
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('evil').toString('base64')].join('.');
    expect(() => decryptSecret(tampered, 'aad')).toThrow();
  });
});

describe('OAuth state', () => {
  it('round-trips a signed state', () => {
    const state = signState({ projectId: 'p1', userId: 'u1' });
    const back = verifyState<{ projectId: string; userId: string }>(state);
    expect(back.projectId).toBe('p1');
    expect(back.userId).toBe('u1');
  });

  it('rejects a forged signature', () => {
    const state = signState({ projectId: 'p1' });
    const [payload] = state.split('.');
    expect(() => verifyState(`${payload}.forged`)).toThrow(/signature/);
  });

  it('rejects an expired state', () => {
    const state = signState({ projectId: 'p1' }, -1);
    expect(() => verifyState(state)).toThrow(/expired/);
  });

  it('produces a valid S256 PKCE pair', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThan(40);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createPkcePair().verifier).not.toBe(verifier);
  });
});

describe('platform error mapping', () => {
  it('turns a Meta token error into a reconnect instruction', () => {
    const err = mapMetaError({ message: 'Session expired', code: 190 }, 400);
    expect(err.code).toBe('connection_error');
    expect(err.remedy).toMatch(/Reconnect Instagram/);
    expect(err.meta.needsAttention).toBe(true);
  });

  it('marks Meta rate limits retryable', () => {
    expect(mapMetaError({ message: 'limit', code: 4 }, 400).retryable).toBe(true);
    expect(mapMetaError({ message: 'quota', code: 9 }, 400).code).toBe('quota_exhausted');
  });

  it('explains a missing Meta permission', () => {
    const err = mapMetaError({ message: 'no permission', code: 10 }, 403);
    expect(err.remedy).toMatch(/App Review/);
  });

  it('explains TikTok URL verification', () => {
    const err = mapTikTokError({ code: 'url_ownership_unverified' }, 400);
    expect(err.remedy).toMatch(/URL Prefix Verification/);
  });

  it('turns a TikTok scope error into a reconnect instruction', () => {
    const err = mapTikTokError({ code: 'scope_not_authorized' }, 403);
    expect(err.code).toBe('connection_error');
    expect(err.remedy).toMatch(/video\.publish/);
  });
});

/* ── Connections ────────────────────────────────────────────────────────── */

describe('connections', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
  });
  afterEach(() => teardown());

  it('stores tokens encrypted and never in plaintext', async () => {
    await connectPlatform(ctx.scope, project, 'instagram');
    const account = await db().findOne(ctx.scope, 'social_accounts', {
      where: { project_id: project.id, platform: 'instagram' },
    });
    const row = await db().findOne(ctx.scope, 'oauth_tokens', {
      where: { social_account_id: account!.id },
    });

    expect(row!.access_token_encrypted).not.toContain('token-instagram');
    expect(row!.access_token_encrypted.startsWith('v1.')).toBe(true);

    const tokens = await loadTokens(ctx.scope, account!);
    expect(tokens!.accessToken).toBe('token-instagram');
  });

  it('refuses to publish when a platform was never connected', async () => {
    await expect(getUsableConnection(ctx.scope, project.id, 'tiktok')).rejects.toThrow(
      /not connected/,
    );
  });

  it('pauses the queue and deletes tokens on disconnect', async () => {
    await connectPlatform(ctx.scope, project, 'instagram');
    const item = await makePost(ctx, project);
    await scheduleContent(ctx.scope, project, [item]);

    await disconnect(ctx.scope, project, 'instagram');

    const account = await db().findOne(ctx.scope, 'social_accounts', {
      where: { project_id: project.id, platform: 'instagram' },
    });
    expect(account!.status).toBe('disconnected');

    const tokens = await db().find(ctx.scope, 'oauth_tokens', {
      where: { social_account_id: account!.id },
    });
    expect(tokens).toHaveLength(0);

    const scheduled = await db().find(ctx.scope, 'scheduled_posts', {
      where: { project_id: project.id },
    });
    // Held, not failed repeatedly.
    expect(scheduled[0].status).toBe('approval_required');
  });
});

/* ── Publishing ─────────────────────────────────────────────────────────── */

describe('publishing', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
    await connectPlatform(ctx.scope, project, 'instagram');
  });
  afterEach(() => teardown());

  it('publishes and records the platform receipt', async () => {
    const item = await makePost(ctx, project);
    const { scheduled } = await scheduleContent(ctx.scope, project, [item]);

    const outcome = await publishScheduledPost(ctx.scope, scheduled[0].id);
    expect(outcome.status).toBe('published');
    expect(outcome.publishedPost!.external_id).toMatch(/^mock-post-/);
    expect(outcome.publishedPost!.platform_response).toBeTruthy();

    const content = await db().get(ctx.scope, 'content_items', item.id);
    expect(content!.status).toBe('published');
    expect(content!.published_at).toBeTruthy();
  });

  it('appends hashtags to the caption it sends', () => {
    const caption = buildCaption({
      caption: 'Body text',
      hashtags: ['#a', '#b'],
    } as ContentItem);
    expect(caption).toBe('Body text\n\n#a #b');
  });

  it('refuses to publish content quality control blocks', async () => {
    const item = await makePost(ctx, project, {
      caption: 'This is 10x faster than anything else and guaranteed to work.',
    });
    const { scheduled } = await scheduleContent(ctx.scope, project, [item]);

    const outcome = await publishScheduledPost(ctx.scope, scheduled[0].id);
    expect(outcome.status).toBe('blocked');

    const content = await db().get(ctx.scope, 'content_items', item.id);
    expect(content!.status).toBe('review_required');

    const notifications = await db().find(ctx.scope, 'notifications', {
      where: { user_id: ctx.user.id },
    });
    expect(notifications.some((n) => n.title.includes('held back'))).toBe(true);
  });

  it('retries a transient failure with backoff instead of giving up', async () => {
    const item = await makePost(ctx, project);
    const { scheduled } = await scheduleContent(ctx.scope, project, [item]);

    ctx.adapters.get('instagram')!.failNextPublish = new FullSendError(
      'platform_error',
      'Instagram had a wobble',
      { retryable: true },
    );

    const outcome = await publishScheduledPost(ctx.scope, scheduled[0].id);
    expect(outcome.status).toBe('retrying');
    expect(outcome.nextAttemptAt).toBeTruthy();

    const post = await db().get(ctx.scope, 'scheduled_posts', scheduled[0].id);
    expect(post!.attempts).toBe(1);
    expect(post!.status).toBe('scheduled');

    // The retry succeeds.
    const second = await publishScheduledPost(ctx.scope, scheduled[0].id);
    expect(second.status).toBe('published');
  });

  it('backs off exponentially and caps', () => {
    expect(backoffMs(1)).toBe(120_000);
    expect(backoffMs(2)).toBe(240_000);
    expect(backoffMs(3)).toBeGreaterThan(backoffMs(2));
    expect(backoffMs(30)).toBe(6 * 60 * 60 * 1000);
  });

  it('stops and asks for help when the connection dies', async () => {
    const item = await makePost(ctx, project);
    const { scheduled } = await scheduleContent(ctx.scope, project, [item]);
    ctx.adapters.get('instagram')!.tokenExpired = true;

    const outcome = await publishScheduledPost(ctx.scope, scheduled[0].id);
    expect(outcome.status).toBe('failed');
    expect(outcome.remedy).toMatch(/Reconnect/);

    const account = await db().findOne(ctx.scope, 'social_accounts', {
      where: { project_id: project.id, platform: 'instagram' },
    });
    expect(account!.status).toBe('expired');

    const errors = await db().find(ctx.scope, 'automation_errors', {
      where: { project_id: project.id },
    });
    expect(errors.length).toBeGreaterThan(0);
    // Not retried into oblivion: it waits for the human.
    const post = await db().get(ctx.scope, 'scheduled_posts', scheduled[0].id);
    expect(post!.next_attempt_at).toBeNull();
  });

  it('resumes automatically once the connection is restored', async () => {
    const item = await makePost(ctx, project);
    const { scheduled } = await scheduleContent(ctx.scope, project, [item]);
    ctx.adapters.get('instagram')!.tokenExpired = true;
    await publishScheduledPost(ctx.scope, scheduled[0].id);

    ctx.adapters.get('instagram')!.tokenExpired = false;
    const resumed = await resumeAfterReconnect(ctx.scope, project.id, 'instagram');
    expect(resumed).toBe(1);

    const post = await db().get(ctx.scope, 'scheduled_posts', scheduled[0].id);
    expect(post!.status).toBe('scheduled');
    expect(post!.attempts).toBe(0);
  });

  it('holds a post when the platform quota is exhausted', async () => {
    const adapter = ctx.adapters.get('instagram')!;
    adapter.quotaLimit = 0;

    const item = await makePost(ctx, project);
    const { scheduled } = await scheduleContent(ctx.scope, project, [item]);

    const outcome = await publishScheduledPost(ctx.scope, scheduled[0].id);
    expect(outcome.status).toBe('retrying');
    expect(outcome.error).toMatch(/limit/i);
  });

  it('refuses a video post with no rendered file, with a real explanation', async () => {
    const item = await makePost(ctx, project, {
      format: 'reel',
      video_plan: {
        total_duration_seconds: 20,
        hook_text: 'x',
        scenes: [
          {
            index: 0,
            duration_seconds: 5,
            visual: 'x',
            on_screen_text: 'x',
            narration: 'x',
            screen_reference: null,
          },
        ],
        narration_script: 'x',
        music_direction: 'x',
        cta_text: 'x',
        rendered_url: null,
        render_status: 'package_only',
        render_note: null,
      },
    });
    const { scheduled } = await scheduleContent(ctx.scope, project, [item]);

    const outcome = await publishScheduledPost(ctx.scope, scheduled[0].id);
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/video/i);
    expect(outcome.remedy).toMatch(/production package/i);
  });
});

/* ── Scheduling ─────────────────────────────────────────────────────────── */

describe('scheduling', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
    await connectPlatform(ctx.scope, project, 'instagram');
  });
  afterEach(() => teardown());

  it('only schedules approved content', async () => {
    const approved = await makePost(ctx, project);
    const held = await makePost(ctx, project, { status: 'review_required' });
    const waiting = await makePost(ctx, project, { status: 'approval_required' });

    const result = await scheduleContent(ctx.scope, project, [approved, held, waiting]);
    expect(result.scheduled).toHaveLength(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.map((s) => s.reason).join(' ')).toMatch(/review|approval/i);
  });

  it('does not schedule the same post twice', async () => {
    const item = await makePost(ctx, project);
    await scheduleContent(ctx.scope, project, [item]);
    const again = await scheduleContent(ctx.scope, project, [item]);
    expect(again.scheduled).toHaveLength(0);
    expect(again.skipped[0].reason).toMatch(/Already scheduled/);
  });

  it('reschedules content and the post together', async () => {
    const item = await makePost(ctx, project);
    const { scheduled } = await scheduleContent(ctx.scope, project, [item]);

    const at = new Date(Date.now() + 3 * 86_400_000);
    await reschedule(ctx.scope, scheduled[0].id, at);

    const post = await db().get(ctx.scope, 'scheduled_posts', scheduled[0].id);
    const content = await db().get(ctx.scope, 'content_items', item.id);
    expect(post!.scheduled_for).toBe(at.toISOString());
    expect(content!.scheduled_for).toBe(at.toISOString());
  });

  it('refuses to reschedule something already published', async () => {
    const item = await makePost(ctx, project);
    const { scheduled } = await scheduleContent(ctx.scope, project, [item]);
    await publishScheduledPost(ctx.scope, scheduled[0].id);

    await expect(
      reschedule(ctx.scope, scheduled[0].id, new Date(Date.now() + 86_400_000)),
    ).rejects.toThrow(/already gone out/);
  });

  it('returns content to approved when unscheduled', async () => {
    const item = await makePost(ctx, project);
    const { scheduled } = await scheduleContent(ctx.scope, project, [item]);
    await unschedule(ctx.scope, scheduled[0].id);

    const content = await db().get(ctx.scope, 'content_items', item.id);
    expect(content!.status).toBe('approved');
    expect(await db().get(ctx.scope, 'scheduled_posts', scheduled[0].id)).toBeNull();
  });

  it('reports the next send and the queue depth', async () => {
    const soon = new Date(Date.now() + 3600_000).toISOString();
    const later = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const a = await makePost(ctx, project, { scheduled_for: later });
    const b = await makePost(ctx, project, { scheduled_for: soon });
    await scheduleContent(ctx.scope, project, [a, b]);

    const next = await nextSend(ctx.scope, project.id);
    expect(next!.content.id).toBe(b.id);

    const depth = await queueDepth(ctx.scope, project.id);
    expect(depth.queued).toBe(2);
    expect(depth.daysOfRunway).toBeGreaterThanOrEqual(4);
  });
});
