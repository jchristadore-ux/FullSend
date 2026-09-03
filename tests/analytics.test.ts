import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectPlatform,
  createProject,
  daysAgo,
  setupContext,
  teardown,
  type TestContext,
} from './helpers';
import { db } from '@/lib/db/repo';
import { newId, nowIso } from '@/lib/ids';
import {
  collectAnalytics,
  engagementRate,
  postPerformance,
  summarise,
  sumMetrics,
  totalEngagement,
} from '@/lib/analytics/collect';
import { computeSendScore, scoreVerdict } from '@/lib/analytics/send-score';
import { applyRecommendation, groupBy, optimize } from '@/lib/optimizer/optimize';
import { emptyMetrics } from '@/lib/social/types';
import { scanTrends } from '@/lib/trends/scan';
import type { ContentFormat, PostMetrics, Project, ProductAnalysis } from '@/lib/types';

function metrics(over: Partial<PostMetrics> = {}): PostMetrics {
  return { ...emptyMetrics(), ...over };
}

/**
 * Publishes `count` posts of a given format with fixed metrics, so the
 * optimizer has a real, controllable signal to read.
 */
async function seedPublished(
  ctx: TestContext,
  project: Project,
  opts: {
    format: ContentFormat;
    count: number;
    metrics: Partial<PostMetrics>;
    pillarId?: string;
    daysBack?: number;
  },
): Promise<void> {
  const account = await db().findOne(ctx.scope, 'social_accounts', {
    where: { project_id: project.id, platform: 'instagram' },
  });

  for (let i = 0; i < opts.count; i++) {
    const publishedAt = daysAgo(opts.daysBack ?? i + 1);
    const item = await db().insert(ctx.scope, 'content_items', {
      id: newId(),
      project_id: project.id,
      campaign_id: null,
      pillar_id: opts.pillarId ?? null,
      persona_id: null,
      platform: 'instagram',
      format: opts.format,
      hook: `Hook ${opts.format} ${i}`,
      script: null,
      caption: `Caption ${opts.format} ${i}`,
      cta: 'Link in bio',
      hashtags: ['#x'],
      video_plan: null,
      slides: null,
      creative_asset_ids: [],
    generation_state: 'complete' as const,
    generation_error: null,
      status: 'published',
      dedup_hash: newId(),
      qc: null,
      scheduled_for: publishedAt,
      published_at: publishedAt,
      origin: 'initial',
      ai_cost_usd: 0,
      created_at: publishedAt,
      updated_at: publishedAt,
    });

    const post = await db().insert(ctx.scope, 'published_posts', {
      id: newId(),
      project_id: project.id,
      content_item_id: item.id,
      scheduled_post_id: null,
      social_account_id: account!.id,
      platform: 'instagram',
      external_id: `ext-${newId()}`,
      permalink: null,
      published_at: publishedAt,
      platform_response: { ok: true },
    });

    await db().insert(ctx.scope, 'analytics', {
      id: newId(),
      project_id: project.id,
      published_post_id: post.id,
      social_account_id: account!.id,
      platform: 'instagram',
      scope: 'post',
      metrics: metrics(opts.metrics),
      from_platform_api: true,
      collected_at: publishedAt,
    });
  }
}

describe('metric maths', () => {
  it('sums engagement across the four interaction signals', () => {
    expect(totalEngagement(metrics({ likes: 10, comments: 2, shares: 3, saves: 5 }))).toBe(20);
  });

  it('computes engagement rate against reach, falling back to views', () => {
    expect(engagementRate(metrics({ reach: 1000, likes: 50 }))).toBeCloseTo(0.05);
    expect(engagementRate(metrics({ views: 500, likes: 50 }))).toBeCloseTo(0.1);
    expect(engagementRate(metrics({ likes: 50 }))).toBe(0);
  });

  it('sums a list of metric snapshots', () => {
    const total = sumMetrics([metrics({ reach: 100, likes: 5 }), metrics({ reach: 200, likes: 7 })]);
    expect(total.reach).toBe(300);
    expect(total.likes).toBe(12);
  });
});

describe('analytics collection', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
    await connectPlatform(ctx.scope, project, 'instagram');
  });
  afterEach(() => teardown());

  it('reads real numbers back from the platform', async () => {
    const account = await db().findOne(ctx.scope, 'social_accounts', {
      where: { project_id: project.id },
    });
    const item = await db().insert(ctx.scope, 'content_items', {
      id: newId(),
      project_id: project.id,
      campaign_id: null,
      pillar_id: null,
      persona_id: null,
      platform: 'instagram',
      format: 'static',
      hook: 'x',
      script: null,
      caption: 'y',
      cta: 'z',
      hashtags: [],
      video_plan: null,
      slides: null,
      creative_asset_ids: [],
    generation_state: 'complete' as const,
    generation_error: null,
      status: 'published',
      dedup_hash: newId(),
      qc: null,
      scheduled_for: nowIso(),
      published_at: nowIso(),
      origin: 'manual',
      ai_cost_usd: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    const adapter = ctx.adapters.get('instagram')!;
    const result = await adapter.publish(
      { accessToken: 't', refreshToken: null, expiresAt: null, refreshExpiresAt: null, scopes: [] },
      await adapter.getAccount(),
      { caption: 'x', format: 'static', mediaUrls: ['https://cdn.test/a.jpg'] },
    );
    adapter.setMetrics(result.externalId, { reach: 4200, likes: 310, saves: 44 });

    await db().insert(ctx.scope, 'published_posts', {
      id: newId(),
      project_id: project.id,
      content_item_id: item.id,
      scheduled_post_id: null,
      social_account_id: account!.id,
      platform: 'instagram',
      external_id: result.externalId,
      permalink: null,
      published_at: nowIso(),
      platform_response: {},
    });

    const collected = await collectAnalytics(ctx.scope, project.id);
    expect(collected.postsCollected).toBe(1);
    expect(collected.errors).toHaveLength(0);

    const snapshots = await db().find(ctx.scope, 'analytics', {
      where: { project_id: project.id, scope: 'post' },
    });
    expect(snapshots[0].metrics.reach).toBe(4200);
    expect(snapshots[0].from_platform_api).toBe(true);
  });

  it('reports honestly when there is no platform data', async () => {
    const summary = await summarise(ctx.scope, project.id);
    expect(summary.postsPublished).toBe(0);
    expect(summary.hasRealData).toBe(false);
    expect(summary.reach).toBe(0);
  });
});

describe('the Send Score', () => {
  it('is zero for a project that has done nothing', () => {
    const score = computeSendScore({
      performance: [],
      queuedPosts: 0,
      daysOfRunway: 0,
      followersGained: 0,
      followerBase: 0,
      daysActive: 1,
      connectedPlatforms: 0,
    });
    expect(score.total).toBe(0);
    expect(scoreVerdict(score.total).label).toBe('Not started');
  });

  it('stays inside 0–100 for extreme inputs', () => {
    const score = computeSendScore({
      performance: [],
      queuedPosts: 100_000,
      daysOfRunway: 10_000,
      followersGained: 1_000_000,
      followerBase: 1,
      daysActive: 1,
      connectedPlatforms: 50,
    });
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(100);
    for (const v of [score.content, score.audience, score.engagement, score.consistency, score.conversion]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('rewards a healthy account over a dormant one', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id);
    await connectPlatform(ctx.scope, project, 'instagram');
    await seedPublished(ctx, project, {
      format: 'carousel',
      count: 10,
      metrics: { reach: 5000, likes: 400, comments: 30, shares: 50, saves: 120, profile_visits: 150, clicks: 30 },
    });
    const performance = await postPerformance(ctx.scope, project.id);

    const healthy = computeSendScore({
      performance,
      queuedPosts: 20,
      daysOfRunway: 21,
      followersGained: 120,
      followerBase: 2000,
      daysActive: 30,
      connectedPlatforms: 2,
    });
    const dormant = computeSendScore({
      performance: [],
      queuedPosts: 0,
      daysOfRunway: 0,
      followersGained: 0,
      followerBase: 2000,
      daysActive: 30,
      connectedPlatforms: 1,
    });

    expect(healthy.total).toBeGreaterThan(dormant.total);
    expect(healthy.drivers.length).toBeGreaterThan(0);
    teardown();
  });

  it('flags a low queue as a negative driver', () => {
    const score = computeSendScore({
      performance: [],
      queuedPosts: 1,
      daysOfRunway: 1,
      followersGained: 0,
      followerBase: 1000,
      daysActive: 10,
      connectedPlatforms: 1,
    });
    expect(score.drivers.some((d) => d.delta < 0 && /queue/i.test(d.label))).toBe(true);
  });
});

describe('the optimizer', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
    await connectPlatform(ctx.scope, project, 'instagram');
  });
  afterEach(() => teardown());

  async function withStrategy() {
    return db().insert(ctx.scope, 'marketing_strategies', {
      id: newId(),
      project_id: project.id,
      version: 1,
      positioning: 'x',
      value_proposition: 'y',
      audience_summary: '',
      pain_points: [],
      differentiators: [],
      campaign_strategy: '',
      posting_cadence: { instagram_per_week: 4, tiktok_per_week: 5, best_times: [] },
      platform_strategy: [
        { platform: 'instagram', rationale: '', formats: ['carousel'], weight: 50 },
        { platform: 'tiktok', rationale: '', formats: ['short_video'], weight: 50 },
      ],
      growth_strategy: '',
      cta_strategy: [],
      content_mix: {
        education: 40,
        product_demo: 25,
        entertainment: 15,
        social_proof: 10,
        promotion: 10,
      },
      approved: true,
      approved_at: nowIso(),
      created_at: nowIso(),
    });
  }

  it('groups performance by a dimension', async () => {
    await seedPublished(ctx, project, { format: 'carousel', count: 3, metrics: { likes: 100 } });
    await seedPublished(ctx, project, { format: 'static', count: 2, metrics: { likes: 10 } });

    const performance = await postPerformance(ctx.scope, project.id);
    const byFormat = groupBy<ContentFormat>(performance, (p) => p.content.format);

    const carousel = byFormat.find((d) => d.key === 'carousel')!;
    const staticRow = byFormat.find((d) => d.key === 'static')!;
    expect(carousel.samples).toBe(3);
    expect(carousel.mean_engagement).toBeGreaterThan(staticRow.mean_engagement);
  });

  it('refuses to draw a conclusion from thin data', async () => {
    await withStrategy();
    await seedPublished(ctx, project, { format: 'carousel', count: 1, metrics: { likes: 500 } });

    const result = await optimize(ctx.scope, project, { autoApply: false });
    expect(result.recommendations.length).toBeGreaterThan(0);
    // With one sample it should talk about volume, not declare a winner.
    expect(result.recommendations[0].statement.toLowerCase()).toMatch(/not enough|signal|volume/);
    const experiments = await db().find(ctx.scope, 'experiments', {
      where: { project_id: project.id },
    });
    for (const e of experiments) expect(e.confident).toBe(false);
  });

  it('forms an opinion once there is real signal', async () => {
    await withStrategy();
    await seedPublished(ctx, project, {
      format: 'carousel',
      count: 5,
      metrics: { reach: 5000, likes: 400, saves: 80 },
    });
    await seedPublished(ctx, project, {
      format: 'static',
      count: 5,
      metrics: { reach: 1000, likes: 20, saves: 2 },
    });

    const result = await optimize(ctx.scope, project, { autoApply: false });
    expect(result.recommendations.length).toBeGreaterThan(0);

    const rec = result.recommendations[0];
    expect(rec.statement).toMatch(/carousel/i);
    expect(rec.evidence.length).toBeGreaterThan(0);
    expect(rec.confidence).toBeGreaterThan(0.5);

    const experiments = await db().find(ctx.scope, 'experiments', {
      where: { project_id: project.id },
    });
    expect(experiments.some((e) => e.confident)).toBe(true);
  });

  it('acts on its own conclusion under Full Send', async () => {
    await withStrategy();
    await seedPublished(ctx, project, {
      format: 'carousel',
      count: 5,
      metrics: { reach: 5000, likes: 400, saves: 80 },
    });
    await seedPublished(ctx, project, {
      format: 'static',
      count: 5,
      metrics: { reach: 1000, likes: 20 },
    });

    const before = await db().findOne(ctx.scope, 'marketing_strategies', {
      where: { project_id: project.id },
    });
    const result = await optimize(ctx.scope, project);
    expect(result.applied.length).toBeGreaterThan(0);

    const after = await db().findOne(ctx.scope, 'marketing_strategies', {
      where: { project_id: project.id },
    });
    // Something concrete changed, not just a note in a table.
    const changed =
      JSON.stringify(after!.posting_cadence) !== JSON.stringify(before!.posting_cadence) ||
      JSON.stringify(after!.content_mix) !== JSON.stringify(before!.content_mix) ||
      JSON.stringify(after!.platform_strategy) !== JSON.stringify(before!.platform_strategy);
    expect(changed).toBe(true);

    const notifications = await db().find(ctx.scope, 'notifications', {
      where: { user_id: ctx.user.id },
    });
    expect(notifications.some((n) => n.title.includes('adjusted'))).toBe(true);
  });

  it('applies a mix shift and keeps the total at 100', async () => {
    const strategy = await withStrategy();
    const rec = await db().insert(ctx.scope, 'recommendations', {
      id: newId(),
      project_id: project.id,
      statement: 'Shift toward demos',
      rationale: '',
      evidence: [],
      action: { type: 'shift_mix', from: 'promotion', to: 'product_demo', points: 5 },
      confidence: 0.9,
      status: 'proposed',
      applied_at: null,
      created_at: nowIso(),
    });

    const applied = await applyRecommendation(ctx.scope, project, rec);
    expect(applied).toBe(true);

    const after = await db().get(ctx.scope, 'marketing_strategies', strategy.id);
    expect(Object.values(after!.content_mix).reduce((a, b) => a + b, 0)).toBe(100);
    expect(after!.content_mix.product_demo).toBeGreaterThan(25);
  });
});

describe('the trend engine', () => {
  let ctx: TestContext;
  let project: Project;

  const analysis = {
    category: 'SaaS product',
    features: [
      { name: 'Digest', description: 'x', evidence: [], user_facing: true },
      { name: 'Inbox', description: 'y', evidence: [], user_facing: true },
    ],
    screens: [
      {
        name: 'Inbox',
        route: '/inbox',
        purpose: 'x',
        key_elements: [],
        workflow: null,
        image_url: null,
        source_file: null,
      },
    ],
    platforms: ['Web'],
    maturity: 'beta',
  } as unknown as ProductAnalysis;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
  });
  afterEach(() => teardown());

  it('only surfaces signals with a real source', async () => {
    const result = await scanTrends(ctx.scope, project.id, analysis);
    expect(result.signals.length).toBeGreaterThan(0);
    for (const s of result.signals) {
      expect(['platform_api', 'repo_context', 'category_pattern']).toContain(s.source);
      if (s.can_participate) expect(s.participation_angle).toBeTruthy();
    }
    expect(result.note).toMatch(/do not expose a general trending-topics API/);
  });

  it('replaces the previous scan rather than accumulating', async () => {
    await scanTrends(ctx.scope, project.id, analysis);
    const first = await db().count(ctx.scope, 'trend_signals', { where: { project_id: project.id } });
    await scanTrends(ctx.scope, project.id, analysis);
    const second = await db().count(ctx.scope, 'trend_signals', {
      where: { project_id: project.id },
    });
    expect(second).toBe(first);
  });

  it('respects the trend-participation setting', async () => {
    await db().insert(ctx.scope, 'settings', {
      id: newId(),
      project_id: project.id,
      auto_publish_pillars: [],
      require_approval_for_promotion: true,
      daily_post_cap: 3,
      quiet_hours: null,
      notify_email: false,
      trend_participation: false,
      updated_at: nowIso(),
    });

    const result = await scanTrends(ctx.scope, project.id, analysis);
    expect(result.signals).toHaveLength(0);
    expect(result.note).toMatch(/switched off/);
  });
});
