/**
 * The full chain, end to end.
 *
 * GitHub repo → analysis → understanding → audience → strategy → pillars →
 * calendar → content → creative → QC → connect → schedule → publish →
 * analytics → performance analysis → optimization → new content.
 *
 * If this passes, the product works.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectPlatform,
  createProject,
  fakeGitHubClient,
  setupContext,
  stubCreativeUrls,
  teardown,
  type TestContext,
} from './helpers';
import { analyzeRepository } from '@/lib/analysis/analyze';
import { approveStrategy, buildStrategy, ensureBrandProfile } from '@/lib/strategy/build';
import { CONTENT_BATCH_SIZE, generateContent } from '@/lib/content/generate';
import { openSlots, queueDepth, scheduleContent } from '@/lib/scheduler/schedule';
import { publishScheduledPost } from '@/lib/publish/publish';
import { collectAnalytics, postPerformance, summarise } from '@/lib/analytics/collect';
import { optimize } from '@/lib/optimizer/optimize';
import { computeSendScore } from '@/lib/analytics/send-score';
import { scanTrends } from '@/lib/trends/scan';
import { topUpContent } from '@/lib/automation/autopilot';
import { db } from '@/lib/db/repo';
import { newId, nowIso } from '@/lib/ids';
import type { Project } from '@/lib/types';

describe('FullSend end-to-end chain', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
  });

  afterEach(() => teardown());

  it('runs the whole machine from a repository to optimized new content', async () => {
    /* 1. Repository analysis. */
    const analyzed = await analyzeRepository(
      ctx.scope,
      project,
      'https://github.com/acme/taskflow',
      { client: fakeGitHubClient() },
    );

    expect(analyzed.repository.name).toBe('taskflow');
    expect(analyzed.analysis.one_liner.length).toBeGreaterThan(5);
    expect(analyzed.analysis.features.length).toBeGreaterThan(0);

    /* 2. Product understanding is grounded in the repo. */
    expect(analyzed.analysis.screens.length).toBeGreaterThan(0);
    expect(analyzed.analysis.not_capabilities.length).toBeGreaterThan(0);

    /* 3. Strategy, pillars, campaigns, brand. */
    const strategy = await buildStrategy(ctx.scope, project, analyzed.analysis);
    strategy.brand = (
      await ensureBrandProfile(ctx.scope, project, analyzed.analysis, strategy.strategy)
    ).brand;
    expect(strategy.pillars.length).toBeGreaterThan(0);
    expect(strategy.campaigns.length).toBeGreaterThan(0);
    expect(strategy.brand!.words_to_avoid.length).toBeGreaterThan(0);

    const mixTotal = Object.values(strategy.strategy.content_mix).reduce((a, b) => a + b, 0);
    expect(mixTotal).toBe(100);

    await approveStrategy(ctx.scope, strategy.strategy.id);
    const approvedStrategy = { ...strategy.strategy, approved: true };

    /* 4. Connect platforms. */
    await connectPlatform(ctx.scope, project, 'instagram');
    await connectPlatform(ctx.scope, project, 'tiktok');

    /* 5. Thirty-day calendar of slots. */
    const slots = await openSlots(ctx.scope, {
      project,
      strategy: approvedStrategy,
      days: 30,
      platforms: ['instagram', 'tiktok'],
    });
    expect(slots.length).toBeGreaterThan(10);

    /* 6. Content generation with creative and quality control. */
    const generated = await generateContent(ctx.scope, {
      project,
      analysis: analyzed.analysis,
      brand: strategy.brand!,
      strategy: approvedStrategy,
      personas: [],
      pillars: strategy.pillars,
      campaigns: strategy.campaigns,
      slots: slots.slice(0, 12),
    });

    /*
     * One call writes one batch, and every brief in that batch is accounted
     * for — written, or rejected by the duplicate guard. Twelve slots go in;
     * the six the batch did not reach come back as work for the next job,
     * which is what stops "thirty posts" from ever being one request.
     *
     * The old assertion here was `> 5`, which quietly required all six briefs
     * to survive the similarity check and failed whenever one legitimately
     * did not.
     */
    expect(generated.created.length + generated.rejectedDuplicates).toBe(CONTENT_BATCH_SIZE);
    expect(generated.remainingSlots).toBe(12 - CONTENT_BATCH_SIZE);
    expect(generated.created.length).toBeGreaterThan(3);
    for (const item of generated.created) {
      expect(item.hook.length).toBeGreaterThan(3);
      expect(item.caption.length).toBeGreaterThan(10);
      expect(item.hashtags.length).toBeGreaterThan(0);
      expect(item.qc).not.toBeNull();
      // Everything ships with creative, never a placeholder.
      expect(item.creative_asset_ids.length).toBeGreaterThan(0);
    }

    // Video formats carry a complete production package.
    const videoItems = generated.created.filter((i) =>
      ['reel', 'short_video', 'story'].includes(i.format),
    );
    for (const v of videoItems) {
      expect(v.video_plan).not.toBeNull();
      expect(v.video_plan!.scenes.length).toBeGreaterThan(0);
      expect(v.video_plan!.rendered_url).toBeNull();
      expect(v.video_plan!.render_status).toBe('package_only');
    }

    /* 7. Scheduling. */
    await stubCreativeUrls(ctx.scope, project.id);
    const approved = generated.created.filter((i) => i.status === 'approved');
    expect(approved.length).toBeGreaterThan(0);

    const scheduleResult = await scheduleContent(ctx.scope, project, approved);
    expect(scheduleResult.scheduled.length).toBe(approved.length);

    const runway = await queueDepth(ctx.scope, project.id);
    expect(runway.queued).toBeGreaterThan(0);

    /* 8. Publishing through the adapter.
     *
     * Video formats have a production package but no rendered file, so they
     * must refuse to publish with a clear reason rather than post something
     * broken. Image formats go out for real. Both behaviours are asserted. */
    let publishedCount = 0;
    let refusedForVideo = 0;

    for (const post of scheduleResult.scheduled.slice(0, 8)) {
      const content = await db().get(ctx.scope, 'content_items', post.content_item_id);
      const needsVideo = ['reel', 'short_video', 'story'].includes(content!.format);
      const outcome = await publishScheduledPost(ctx.scope, post.id);

      if (needsVideo) {
        expect(outcome.status).toBe('failed');
        expect(outcome.error).toContain('video');
        expect(outcome.remedy).toBeTruthy();
        refusedForVideo++;
      } else {
        expect(outcome.status).toBe('published');
        publishedCount++;
      }
    }
    expect(publishedCount + refusedForVideo).toBeGreaterThan(0);
    expect(publishedCount).toBeGreaterThan(0);

    const publishedRows = await db().find(ctx.scope, 'published_posts', {
      where: { project_id: project.id },
    });
    expect(publishedRows.length).toBe(publishedCount);
    // Every publish keeps the platform's own receipt.
    expect(publishedRows[0].platform_response).toBeTruthy();

    /* 9. Analytics — give the mock platform real numbers to return. */
    for (const row of publishedRows) {
      const adapter = ctx.adapters.get(row.platform)!;
      const isReel = ['reel', 'short_video'].includes(
        (await db().get(ctx.scope, 'content_items', row.content_item_id))!.format,
      );
      adapter.setMetrics(row.external_id, {
        views: isReel ? 5200 : 1400,
        reach: isReel ? 4800 : 1300,
        impressions: isReel ? 5200 : 1400,
        likes: isReel ? 420 : 78,
        comments: isReel ? 38 : 6,
        shares: isReel ? 52 : 4,
        saves: isReel ? 96 : 21,
        profile_visits: isReel ? 140 : 30,
        clicks: isReel ? 26 : 5,
        follows: isReel ? 18 : 3,
      });
    }

    const collection = await collectAnalytics(ctx.scope, project.id);
    expect(collection.postsCollected).toBe(publishedRows.length);
    expect(collection.errors).toHaveLength(0);

    const summary = await summarise(ctx.scope, project.id);
    expect(summary.postsPublished).toBe(publishedRows.length);
    expect(summary.reach).toBeGreaterThan(0);
    expect(summary.hasRealData).toBe(true);

    /* 10. Send Score. */
    const performance = await postPerformance(ctx.scope, project.id);
    const score = computeSendScore({
      performance,
      queuedPosts: runway.queued,
      daysOfRunway: runway.daysOfRunway,
      followersGained: 21,
      followerBase: 2000,
      daysActive: 14,
      connectedPlatforms: 2,
    });
    expect(score.total).toBeGreaterThan(0);
    expect(score.total).toBeLessThanOrEqual(100);
    expect(score.drivers.length).toBeGreaterThan(0);

    /* 11. Performance analysis and optimization. */
    const optimized = await optimize(ctx.scope, project);
    expect(optimized.postsAnalyzed).toBe(publishedRows.length);
    expect(optimized.recommendations.length).toBeGreaterThan(0);
    expect(optimized.recommendations[0].statement.length).toBeGreaterThan(10);
    // Full Send mode acts on its own conclusions.
    expect(optimized.applied.length).toBeGreaterThan(0);
    expect(optimized.experiments.length).toBeGreaterThan(0);

    /* 12. Trend engine grounded in real signals only. */
    const trends = await scanTrends(ctx.scope, project.id, analyzed.analysis);
    expect(trends.signals.length).toBeGreaterThan(0);
    for (const s of trends.signals) {
      expect(['platform_api', 'repo_context', 'category_pattern']).toContain(s.source);
    }

    /* 13. New content, informed by what was learned. */
    const before = await db().count(ctx.scope, 'content_items', {
      where: { project_id: project.id },
    });
    // The 14-day window is legitimately full by now — every slot in it already
    // has a post written for it — so the top-up extends the horizon, which is
    // exactly what autopilot does when runway gets short.
    const topUp = await topUpContent(ctx.scope, project, 60, 'More of what is working');
    const after = await db().count(ctx.scope, 'content_items', {
      where: { project_id: project.id },
    });
    // The reason is the assertion message: a bare "expected 0 to be greater
    // than 0" in CI says nothing about which of the top-up guards fired.
    expect(topUp.generated, topUp.reason).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(before);

    /* 14. Cost was tracked throughout. */
    const usage = await db().find(ctx.scope, 'ai_usage', { where: { project_id: project.id } });
    expect(usage.length).toBeGreaterThan(0);
  }, 120_000);

  it('records an actionable error and pauses when a connection dies mid-flight', async () => {
    const analysis = await seedAnalysis(ctx, project);
    await connectPlatform(ctx.scope, project, 'instagram');

    const item = await db().insert(ctx.scope, 'content_items', {
      id: newId(),
      project_id: project.id,
      campaign_id: null,
      pillar_id: null,
      persona_id: null,
      platform: 'instagram',
      format: 'static',
      hook: 'A perfectly reasonable hook about tasks',
      script: null,
      caption: 'This is a caption that passes every quality control check cleanly.',
      cta: 'Link in bio',
      hashtags: ['#productivity'],
      video_plan: null,
      slides: null,
      creative_asset_ids: [],
      status: 'approved',
      dedup_hash: 'unique-hash-1',
      qc: null,
      scheduled_for: nowIso(),
      published_at: null,
      origin: 'manual',
      ai_cost_usd: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
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
      url: 'https://cdn.fullsend.test/a.jpg',
      storage_path: null,
      svg: null,
      alt_text: 'card',
      created_at: nowIso(),
    });
    await db().update(ctx.scope, 'content_items', item.id, {
      creative_asset_ids: [asset.id],
    });

    const { scheduled } = await scheduleContent(ctx.scope, project, [
      { ...item, creative_asset_ids: [asset.id] },
    ]);

    // The platform connection dies before the post fires.
    ctx.adapters.get('instagram')!.tokenExpired = true;

    const outcome = await publishScheduledPost(ctx.scope, scheduled[0].id);
    expect(outcome.status).toBe('failed');
    expect(outcome.remedy).toContain('Reconnect');

    const account = await db().findOne(ctx.scope, 'social_accounts', {
      where: { project_id: project.id, platform: 'instagram' },
    });
    expect(account!.status).toBe('expired');

    // The founder is told, with a way to fix it.
    const notifications = await db().find(ctx.scope, 'notifications', {
      where: { user_id: ctx.user.id },
    });
    const attention = notifications.find((n) => n.title.includes('needs attention'));
    expect(attention).toBeTruthy();
    expect(attention!.action_href).toContain('reconnect');

    // And publishing resumes once it is fixed.
    ctx.adapters.get('instagram')!.tokenExpired = false;
    const { resumeAfterReconnect } = await import('@/lib/publish/publish');
    const resumed = await resumeAfterReconnect(ctx.scope, project.id, 'instagram');
    expect(resumed).toBe(1);

    void analysis;
  }, 60_000);
});

async function seedAnalysis(ctx: TestContext, project: Project) {
  const { ingestRepository } = await import('@/lib/github/ingest');
  const bundle = await ingestRepository({ owner: 'acme', name: 'taskflow' }, fakeGitHubClient());
  return bundle;
}
