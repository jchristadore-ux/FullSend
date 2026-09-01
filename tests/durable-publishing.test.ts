/**
 * Publishing as durable state.
 *
 * The failure this file exists for: Instagram accepts the post, and the reply
 * never arrives. The publish happened; nothing on this side knows it. A retry
 * that assumes failure posts the same thing to the founder's account twice,
 * and no amount of care further up the stack undoes that.
 *
 * So every test here is about what survives an interruption — a lost response,
 * a dead worker, a closed browser — and what must never happen twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectPlatform,
  createProject,
  setupContext,
  teardown,
  type TestContext,
} from './helpers';
import { db, dueScheduledPosts, enqueue } from '@/lib/db/repo';
import { systemScope } from '@/lib/db';
import { newId, nowIso } from '@/lib/ids';
import { drainQueue, runJob } from '@/lib/jobs/runner';
import { enqueueDuePublishJobs } from '@/lib/automation/autopilot';
import { publishScheduledPost } from '@/lib/publish/publish';
import { scheduleContent } from '@/lib/scheduler/schedule';
import { pipelineState } from '@/lib/pipeline/state';
import { FullSendError } from '@/lib/errors';
import type { ContentItem, Job, Project, ScheduledPost } from '@/lib/types';

async function makeDuePost(
  ctx: TestContext,
  project: Project,
  overrides: Partial<ContentItem> = {},
): Promise<ScheduledPost> {
  const item = await db().insert(ctx.scope, 'content_items', {
    id: newId(),
    project_id: project.id,
    campaign_id: null,
    pillar_id: null,
    persona_id: null,
    platform: 'instagram',
    format: 'static',
    hook: `A hook worth reading ${newId().slice(0, 8)}`,
    script: null,
    caption: 'A caption that passes every quality control check without any trouble.',
    cta: 'Link in bio',
    hashtags: ['#productivity'],
    video_plan: null,
    slides: null,
    creative_asset_ids: [],
    status: 'approved',
    dedup_hash: newId(),
    qc: null,
    // Due a minute ago, so the sweep picks it up.
    scheduled_for: new Date(Date.now() - 60_000).toISOString(),
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

  const withCreative = await db().update(ctx.scope, 'content_items', item.id, {
    creative_asset_ids: [asset.id],
  });
  const { scheduled } = await scheduleContent(ctx.scope, project, [withCreative]);
  return scheduled[0];
}

describe('publishing through the queue', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
    await connectPlatform(ctx.scope, project, 'instagram');
  });
  afterEach(() => teardown());

  it('turns a due post into a durable job instead of publishing inline', async () => {
    const post = await makeDuePost(ctx, project);

    const swept = await enqueueDuePublishJobs();
    expect(swept.due).toBe(1);
    expect(swept.queued).toBe(1);

    // Nothing has been published yet: the sweep only writes work down.
    expect(await db().find(ctx.scope, 'published_posts', {})).toHaveLength(0);
    const jobs = await db().find(ctx.scope, 'jobs', { where: { type: 'publish_post' } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.scheduledPostId).toBe(post.id);

    // The worker is what publishes, one post per pass.
    const drained = await drainQueue({ max: 10 });
    expect(drained.processed).toBe(1);
    expect(drained.stopped).toBe('heavy');

    const published = await db().find(ctx.scope, 'published_posts', {});
    expect(published).toHaveLength(1);
    expect((await db().get(ctx.scope, 'scheduled_posts', post.id))!.status).toBe('published');
  });

  it('sweeps the same due post only once, however often it runs', async () => {
    await makeDuePost(ctx, project);
    await enqueueDuePublishJobs();
    const second = await enqueueDuePublishJobs();
    expect(second.queued).toBe(0);
    expect(await db().find(ctx.scope, 'jobs', { where: { type: 'publish_post' } })).toHaveLength(1);
  });

  it('publishes one post per pass, not the whole backlog', async () => {
    for (let i = 0; i < 3; i++) await makeDuePost(ctx, project);
    await enqueueDuePublishJobs();

    const first = await drainQueue({ max: 25 });
    expect(first.processed).toBe(1);
    expect(await db().find(ctx.scope, 'published_posts', {})).toHaveLength(1);

    await drainQueue({ max: 25 });
    await drainQueue({ max: 25 });
    expect(await db().find(ctx.scope, 'published_posts', {})).toHaveLength(3);
  });
});

describe('a publish whose response never came back', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
    await connectPlatform(ctx.scope, project, 'instagram');
  });
  afterEach(() => teardown());

  it('records the attempt before it asks the platform to do anything', async () => {
    const post = await makeDuePost(ctx, project);
    await publishScheduledPost(ctx.scope, post.id);

    const saved = await db().get(ctx.scope, 'scheduled_posts', post.id);
    expect(saved!.platform_container_id).toBeTruthy();
    expect(saved!.publish_submitted_at).toBeTruthy();
    expect(saved!.started_at).toBeTruthy();
    expect(saved!.published_at).toBeTruthy();
  });

  it('finds the live post on retry rather than publishing it a second time', async () => {
    const post = await makeDuePost(ctx, project);
    const adapter = ctx.adapters.get('instagram')!;

    // The post goes live; the reply is lost on the way back.
    adapter.losePublishResponse = true;
    const first = await publishScheduledPost(ctx.scope, post.id);
    expect(first.status).toBe('retrying');
    expect(adapter.posts.size).toBe(1);

    // Everything needed to work out what happened is on the row.
    const held = await db().get(ctx.scope, 'scheduled_posts', post.id);
    expect(held!.publish_submitted_at).toBeTruthy();
    expect(held!.status).toBe('scheduled');

    const second = await publishScheduledPost(ctx.scope, post.id);
    expect(second.status).toBe('published');

    // One post on the platform, one receipt here. Not two of either.
    expect(adapter.posts.size).toBe(1);
    const receipts = await db().find(ctx.scope, 'published_posts', {});
    expect(receipts).toHaveLength(1);
    expect(receipts[0].external_id).toBe([...adapter.posts.keys()][0]);
    expect(receipts[0].platform_response.recovered).toBe(true);
  });

  it('survives the worker being killed between the attempt and the receipt', async () => {
    const post = await makeDuePost(ctx, project);
    const adapter = ctx.adapters.get('instagram')!;
    adapter.losePublishResponse = true;

    const job = await enqueue(
      systemScope('test'),
      'publish_post',
      { scheduledPostId: post.id, projectId: project.id },
      { projectId: project.id },
    );
    await runJob({ ...((await db().get(systemScope('test'), 'jobs', job.id)) as Job), attempts: 1 });

    // The job is requeued with a backoff; make it due and let the worker retry.
    await db().update(systemScope('test'), 'jobs', job.id, { run_after: nowIso() });
    const drained = await drainQueue({ max: 5 });
    expect(drained.processed).toBe(1);

    expect(adapter.posts.size).toBe(1);
    expect(await db().find(ctx.scope, 'published_posts', {})).toHaveLength(1);
    expect((await db().get(ctx.scope, 'scheduled_posts', post.id))!.status).toBe('published');
  });

  it('reuses the container it already built instead of uploading again', async () => {
    const post = await makeDuePost(ctx, project);
    const adapter = ctx.adapters.get('instagram')!;

    // Fail after the container exists but before anything is published.
    adapter.failNextPublish = new FullSendError('platform_error', 'a wobble', { retryable: true });
    await publishScheduledPost(ctx.scope, post.id);
    const containerId = (await db().get(ctx.scope, 'scheduled_posts', post.id))!
      .platform_container_id;
    expect(containerId).toBeTruthy();

    await publishScheduledPost(ctx.scope, post.id);
    const published = [...adapter.posts.values()];
    expect(published).toHaveLength(1);
    expect(published[0].containerId).toBe(containerId);
  });

  it('publishes once when two workers sweep the same post at the same time', async () => {
    const post = await makeDuePost(ctx, project);
    const adapter = ctx.adapters.get('instagram')!;

    await Promise.all([enqueueDuePublishJobs(), enqueueDuePublishJobs()]);
    const jobs = await db().find(ctx.scope, 'jobs', { where: { type: 'publish_post' } });
    expect(jobs).toHaveLength(1);

    await Promise.all([drainQueue({ max: 5 }), drainQueue({ max: 5 })]);

    expect(adapter.posts.size).toBe(1);
    expect(await db().find(ctx.scope, 'published_posts', {})).toHaveLength(1);
    void post;
  });

  it('will not write a second receipt for a post that already has one', async () => {
    // The database constraint behind the application check, exercised directly:
    // two receipts for one scheduled post is the shape of a double publish.
    const post = await makeDuePost(ctx, project);
    await publishScheduledPost(ctx.scope, post.id);
    const receipt = (await db().find(ctx.scope, 'published_posts', {}))[0];

    await expect(
      db().insert(ctx.scope, 'published_posts', {
        ...receipt,
        id: newId(),
        external_id: 'a-different-media-id',
      }),
    ).rejects.toThrow();
  });

  it('does nothing at all when the post is already published', async () => {
    const post = await makeDuePost(ctx, project);
    await publishScheduledPost(ctx.scope, post.id);
    const adapter = ctx.adapters.get('instagram')!;

    const again = await publishScheduledPost(ctx.scope, post.id);
    expect(again.status).toBe('published');
    expect(adapter.posts.size).toBe(1);
    expect(await db().find(ctx.scope, 'published_posts', {})).toHaveLength(1);
  });
});

describe('what the screen is allowed to claim', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
    await connectPlatform(ctx.scope, project, 'instagram');
  });
  afterEach(() => teardown());

  it('counts publishing from the rows, so a refresh cannot change it', async () => {
    const going = await makeDuePost(ctx, project);
    await makeDuePost(ctx, project, {
      scheduled_for: new Date(Date.now() + 86_400_000).toISOString(),
    });

    // Nothing has gone out yet.
    let state = await pipelineState(ctx.scope, project);
    expect(state.publishing).toMatchObject({ published: 0, inFlight: 0, failed: 0, scheduled: 2 });

    // A queued job is work in flight, not a finished post.
    await enqueueDuePublishJobs();
    state = await pipelineState(ctx.scope, project);
    expect(state.publishing).toMatchObject({ published: 0, inFlight: 1, scheduled: 1 });

    await drainQueue({ max: 5 });
    state = await pipelineState(ctx.scope, project);
    expect(state.publishing).toMatchObject({ published: 1, inFlight: 0, scheduled: 1 });

    // Reading it again changes nothing: it is the database, not a memory of
    // what a request once returned.
    const again = await pipelineState(ctx.scope, project);
    expect(again.publishing).toEqual(state.publishing);
    void going;
  });

  it('shows a post held for a person as needing them, not as published', async () => {
    await makeDuePost(ctx, project);
    ctx.adapters.get('instagram')!.tokenExpired = true;
    await enqueueDuePublishJobs();
    await drainQueue({ max: 5 });

    const state = await pipelineState(ctx.scope, project);
    expect(state.publishing.published).toBe(0);
    expect(state.publishing.failed).toBe(1);
  });
});

describe('a post left mid-publish by a dead worker', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
    await connectPlatform(ctx.scope, project, 'instagram');
  });
  afterEach(() => teardown());

  it('is picked back up rather than left going out forever', async () => {
    const post = await makeDuePost(ctx, project);
    // The shape a killed worker leaves behind: claimed, never finished.
    await db().update(ctx.scope, 'scheduled_posts', post.id, {
      status: 'publishing',
      started_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    // Not due (its slot has passed) and not failed, so nothing else sweeps it.
    expect(await dueScheduledPosts(systemScope('test'), nowIso())).toHaveLength(0);

    const swept = await enqueueDuePublishJobs();
    expect(swept.recovered).toBe(1);
    expect(swept.queued).toBe(1);

    await drainQueue({ max: 5 });
    expect((await db().get(ctx.scope, 'scheduled_posts', post.id))!.status).toBe('published');
    expect(await db().find(ctx.scope, 'published_posts', {})).toHaveLength(1);
  });

  it('leaves a publish that only just started alone', async () => {
    const post = await makeDuePost(ctx, project);
    await db().update(ctx.scope, 'scheduled_posts', post.id, {
      status: 'publishing',
      started_at: nowIso(),
    });

    const swept = await enqueueDuePublishJobs();
    expect(swept.recovered).toBe(0);
    expect(swept.queued).toBe(0);
  });
});

describe('a post that has given up', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
    await connectPlatform(ctx.scope, project, 'instagram');
  });
  afterEach(() => teardown());

  it('is not swept back in behind the founder’s back', async () => {
    const post = await makeDuePost(ctx, project);
    // The connection died: the post is held for a person, not for a retry.
    ctx.adapters.get('instagram')!.tokenExpired = true;
    await publishScheduledPost(ctx.scope, post.id);
    expect((await db().get(ctx.scope, 'scheduled_posts', post.id))!.status).toBe('failed');

    ctx.adapters.get('instagram')!.tokenExpired = false;
    expect(await dueScheduledPosts(systemScope('test'), nowIso())).toHaveLength(0);
    expect((await enqueueDuePublishJobs()).queued).toBe(0);
  });
});
