import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, fakeGitHubClient, setupContext, teardown, type TestContext } from './helpers';
import { analyzeRepository } from '@/lib/analysis/analyze';
import { approveStrategy, buildStrategy, normaliseMix } from '@/lib/strategy/build';
import { generateContent } from '@/lib/content/generate';
import { allocate, planSlots, shiftMix, formatFor } from '@/lib/content/mix';
import { checkDuplicate, contentFingerprint, similarity } from '@/lib/content/dedup';
import { openSlots } from '@/lib/scheduler/schedule';
import { runQualityControl, canAutoPublish } from '@/lib/qc/check';
import { wrapText } from '@/lib/creative/render';
import { buildVideoPackage } from '@/lib/video/package';
import type { ContentMix, PillarType, Project } from '@/lib/types';

describe('content mix planning', () => {
  it('allocates exactly the requested number of slots', () => {
    const mix: ContentMix = {
      education: 40,
      product_demo: 25,
      entertainment: 15,
      social_proof: 10,
      promotion: 10,
    };
    for (const total of [1, 5, 12, 20, 37, 90]) {
      const allocation = allocate(mix, total);
      const sum = Object.values(allocation).reduce((a, b) => a + b, 0);
      expect(sum).toBe(total);
    }
  });

  it('never silently drops a pillar the strategy asked for', () => {
    const mix: ContentMix = {
      education: 60,
      product_demo: 20,
      entertainment: 10,
      social_proof: 5,
      promotion: 5,
    };
    const allocation = allocate(mix, 10);
    for (const key of Object.keys(mix) as PillarType[]) {
      expect(allocation[key]).toBeGreaterThan(0);
    }
  });

  it('normalises a mix that does not total 100', () => {
    const normalised = normaliseMix({
      education: 50,
      product_demo: 50,
      entertainment: 50,
      social_proof: 25,
      promotion: 25,
    });
    expect(Object.values(normalised).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('shifts the mix without starving a pillar completely', () => {
    const mix: ContentMix = {
      education: 40,
      product_demo: 25,
      entertainment: 15,
      social_proof: 10,
      promotion: 10,
    };
    const shifted = shiftMix(mix, 'promotion', 'product_demo', 40);
    expect(shifted.promotion).toBeGreaterThanOrEqual(5);
    expect(shifted.product_demo).toBeGreaterThan(mix.product_demo);
    expect(Object.values(shifted).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('only picks formats the platform actually supports', () => {
    for (let seed = 0; seed < 8; seed++) {
      expect(formatFor('tiktok', 'education', seed)).toBe('short_video');
      expect(['reel', 'carousel', 'static', 'story']).toContain(
        formatFor('instagram', 'product_demo', seed),
      );
    }
  });

  it('plans slots in the future and respects the daily cap', () => {
    const from = new Date('2026-01-05T08:00:00Z');
    const slots = planSlots({
      days: 14,
      from,
      strategy: {
        content_mix: {
          education: 40,
          product_demo: 25,
          entertainment: 15,
          social_proof: 10,
          promotion: 10,
        },
        posting_cadence: { instagram_per_week: 4, tiktok_per_week: 5, best_times: [] },
        platform_strategy: [],
      },
      platforms: ['instagram', 'tiktok'],
      dailyCap: 2,
    });

    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(s.at.getTime()).toBeGreaterThan(from.getTime());

    const perDay = new Map<string, number>();
    for (const s of slots) {
      const key = s.at.toISOString().slice(0, 10);
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    for (const count of perDay.values()) expect(count).toBeLessThanOrEqual(2);
  });

  it('moves a slot out of quiet hours', () => {
    const slots = planSlots({
      days: 7,
      from: new Date('2026-01-05T08:00:00Z'),
      strategy: {
        content_mix: {
          education: 100,
          product_demo: 0,
          entertainment: 0,
          social_proof: 0,
          promotion: 0,
        },
        posting_cadence: {
          instagram_per_week: 5,
          tiktok_per_week: 0,
          best_times: [{ day: 1, hour: 23, platform: 'instagram' }],
        },
        platform_strategy: [],
      },
      platforms: ['instagram'],
      dailyCap: 5,
      quietHours: { start: 22, end: 7 },
    });

    for (const s of slots) {
      const hour = s.at.getUTCHours();
      expect(hour >= 22 || hour < 7).toBe(false);
    }
  });
});

describe('duplicate prevention', () => {
  it('fingerprints the same idea identically regardless of word order', () => {
    const a = contentFingerprint({
      platform: 'instagram',
      format: 'reel',
      hook: 'Stop doing scheduling manually',
    });
    const b = contentFingerprint({
      platform: 'instagram',
      format: 'reel',
      hook: 'Manually doing scheduling? Stop.',
    });
    expect(a).toBe(b);
  });

  it('treats the same idea on two platforms as two posts', () => {
    const ig = contentFingerprint({ platform: 'instagram', format: 'reel', hook: 'Stop doing X' });
    const tt = contentFingerprint({ platform: 'tiktok', format: 'reel', hook: 'Stop doing X' });
    expect(ig).not.toBe(tt);
  });

  it('rejects an exact repeat', () => {
    const existing = [
      {
        id: 'a',
        platform: 'instagram' as const,
        hook: 'Stop doing scheduling manually',
        caption: 'Some caption here about scheduling work',
        dedup_hash: contentFingerprint({
          platform: 'instagram',
          format: 'reel',
          hook: 'Stop doing scheduling manually',
        }),
      },
    ];
    const verdict = checkDuplicate(
      {
        platform: 'instagram',
        format: 'reel',
        hook: 'Stop doing scheduling manually',
        caption: 'Different caption entirely',
      },
      existing,
    );
    expect(verdict.unique).toBe(false);
    expect(verdict.conflictsWith).toBe('a');
  });

  it('rejects a near-duplicate the fingerprint would miss', () => {
    const existing = [
      {
        id: 'a',
        platform: 'instagram' as const,
        hook: 'Three things about automated scheduling nobody tells you',
        caption: 'Automated scheduling saves hours every week for busy teams everywhere',
        dedup_hash: 'unrelated',
      },
    ];
    const verdict = checkDuplicate(
      {
        platform: 'instagram',
        format: 'carousel',
        hook: 'Three things nobody tells you about automated scheduling',
        caption: 'Automated scheduling saves busy teams hours every week everywhere',
      },
      existing,
    );
    expect(verdict.unique).toBe(false);
    expect(verdict.similarityScore).toBeGreaterThan(0.6);
  });

  it('lets genuinely different content through', () => {
    const existing = [
      {
        id: 'a',
        platform: 'instagram' as const,
        hook: 'Three things about scheduling nobody tells you',
        caption: 'Scheduling saves hours every week',
        dedup_hash: 'unrelated',
      },
    ];
    const verdict = checkDuplicate(
      {
        platform: 'instagram',
        format: 'reel',
        hook: 'Watch the analytics dashboard update live',
        caption: 'Real numbers arriving from the platform APIs as they publish',
      },
      existing,
    );
    expect(verdict.unique).toBe(true);
  });

  it('scores similarity symmetrically', () => {
    const a = 'the quick brown fox jumped over something';
    const b = 'something jumped over the quick brown fox';
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 5);
    expect(similarity(a, a)).toBe(1);
  });
});

describe('creative typesetting', () => {
  it('wraps to the line budget and ellipsises overflow', () => {
    const lines = wrapText('a '.repeat(200).trim(), 24, 4);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines[lines.length - 1]).toMatch(/…$/);
  });

  it('leaves short text alone', () => {
    expect(wrapText('Stop doing this manually', 40, 4)).toEqual(['Stop doing this manually']);
  });
});

describe('video production packages', () => {
  it('always produces a complete package and never claims a render', () => {
    const plan = buildVideoPackage({
      hook: 'This used to take an hour',
      caption: 'Line one\nLine two\nLine three',
      cta: 'Link in bio',
      analysis: {
        features: [{ name: 'Digest', description: 'A daily digest', evidence: [], user_facing: true }],
        screens: [
          {
            name: 'Inbox',
            route: '/inbox',
            purpose: 'x',
            key_elements: ['Extract tasks'],
            workflow: null,
            image_url: null,
            source_file: null,
          },
        ],
        one_liner: 'x',
        problem_solved: 'Doing it by hand',
      },
      platform: 'tiktok',
    });

    expect(plan.scenes.length).toBeGreaterThan(2);
    expect(plan.total_duration_seconds).toBeGreaterThan(5);
    expect(plan.narration_script.length).toBeGreaterThan(10);
    // Nothing pretends a file exists.
    expect(plan.rendered_url).toBeNull();
    expect(plan.render_status).toBe('package_only');
    expect(plan.render_note).toContain('production package');
    // Demo scenes reference a real screen.
    expect(plan.scenes.some((s) => s.screen_reference === 'Inbox')).toBe(true);
  });

  it('keeps a reel inside the platform ceiling', () => {
    const plan = buildVideoPackage({
      hook: 'x',
      caption: 'y',
      cta: 'z',
      analysis: { features: [], screens: [], one_liner: 'x', problem_solved: 'y' },
      platform: 'instagram',
    });
    expect(plan.total_duration_seconds).toBeLessThanOrEqual(90);
  });
});

describe('content generation', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
  });
  afterEach(() => teardown());

  async function fullSetup() {
    const analyzed = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });
    const built = await buildStrategy(ctx.scope, project, analyzed.analysis, analyzed.personas);
    const strategy = await approveStrategy(ctx.scope, built.strategy.id);
    return { analyzed, built, strategy };
  }

  it('produces complete, publishable posts', async () => {
    const { analyzed, built, strategy } = await fullSetup();
    const slots = await openSlots(ctx.scope, {
      project,
      strategy,
      days: 14,
      platforms: ['instagram', 'tiktok'],
    });

    const result = await generateContent(ctx.scope, {
      project,
      analysis: analyzed.analysis,
      brand: built.brand,
      strategy,
      personas: analyzed.personas,
      pillars: built.pillars,
      campaigns: built.campaigns,
      slots,
    });

    expect(result.created.length).toBeGreaterThan(3);
    for (const item of result.created) {
      expect(item.hook.trim().length).toBeGreaterThan(3);
      expect(item.caption.trim().length).toBeGreaterThan(10);
      expect(item.cta.length).toBeGreaterThan(0);
      expect(item.hashtags.length).toBeGreaterThan(0);
      expect(item.hashtags.every((h) => h.startsWith('#'))).toBe(true);
      expect(item.creative_asset_ids.length).toBeGreaterThan(0);
      expect(item.dedup_hash).toHaveLength(64);
      expect(item.qc).not.toBeNull();
      // No unfilled templates ever reach the database.
      expect(`${item.hook} ${item.caption}`).not.toMatch(/\{[a-z_]+\}/);
    }
  });

  it('gives carousels slides and videos scene plans', async () => {
    const { analyzed, built, strategy } = await fullSetup();
    const slots = await openSlots(ctx.scope, {
      project,
      strategy,
      days: 30,
      platforms: ['instagram', 'tiktok'],
    });
    const result = await generateContent(ctx.scope, {
      project,
      analysis: analyzed.analysis,
      brand: built.brand,
      strategy,
      personas: analyzed.personas,
      pillars: built.pillars,
      campaigns: built.campaigns,
      slots,
    });

    for (const item of result.created) {
      if (item.format === 'carousel') {
        expect(item.slides?.length ?? 0).toBeGreaterThanOrEqual(2);
      }
      if (['reel', 'short_video', 'story'].includes(item.format)) {
        expect(item.video_plan).not.toBeNull();
        expect(item.video_plan!.scenes.length).toBeGreaterThan(0);
      }
    }
  });

  it('does not repeat itself across two generation runs', async () => {
    const { analyzed, built, strategy } = await fullSetup();
    const common = {
      project,
      analysis: analyzed.analysis,
      brand: built.brand,
      strategy,
      personas: analyzed.personas,
      pillars: built.pillars,
      campaigns: built.campaigns,
    };

    const first = await generateContent(ctx.scope, {
      ...common,
      slots: await openSlots(ctx.scope, { project, strategy, days: 30, platforms: ['instagram'] }),
    });
    const second = await generateContent(ctx.scope, {
      ...common,
      slots: await openSlots(ctx.scope, { project, strategy, days: 90, platforms: ['instagram'] }),
    });

    const hashes = [...first.created, ...second.created].map((c) => c.dedup_hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('quality control', () => {
  const baseItem = {
    platform: 'instagram' as const,
    format: 'static' as const,
    hook: 'A perfectly ordinary hook about tasks',
    caption: 'A perfectly ordinary caption that says something useful about the product.',
    cta: 'Link in bio',
    hashtags: ['#productivity'],
    video_plan: null,
    slides: null,
  };

  const analysis = {
    features: [{ name: 'Digest', description: 'x', evidence: [], user_facing: true }],
    not_capabilities: ['Revenue guarantees'],
    one_liner: 'x',
  };

  it('passes clean content', () => {
    const qc = runQualityControl({ item: baseItem, analysis, brand: null });
    expect(qc.passed).toBe(true);
    expect(qc.requires_human_review).toBe(false);
  });

  it('blocks unsupported quantified claims', () => {
    for (const caption of [
      'This is 10x faster than doing it by hand.',
      'Save 20 hours every week with this.',
      'Join 50,000 users already using it.',
      'The #1 tool for teams.',
      'Guaranteed results in seven days.',
    ]) {
      const qc = runQualityControl({ item: { ...baseItem, caption }, analysis, brand: null });
      expect(qc.passed, caption).toBe(false);
      expect(qc.findings.some((f) => f.check === 'unsupported_claim')).toBe(true);
    }
  });

  it('blocks platform limit violations', () => {
    const tooLong = runQualityControl({
      item: { ...baseItem, caption: 'x'.repeat(2500) },
      analysis,
      brand: null,
    });
    expect(tooLong.passed).toBe(false);

    const tooManyTags = runQualityControl({
      item: { ...baseItem, hashtags: Array.from({ length: 40 }, (_, i) => `#tag${i}`) },
      analysis,
      brand: null,
    });
    expect(tooManyTags.passed).toBe(false);
  });

  it('blocks a carousel with fewer than two slides', () => {
    const qc = runQualityControl({
      item: { ...baseItem, format: 'carousel', slides: [{ headline: 'One', body: 'Only' }] },
      analysis,
      brand: null,
    });
    expect(qc.passed).toBe(false);
  });

  it('blocks an unfilled template placeholder', () => {
    const qc = runQualityControl({
      item: { ...baseItem, caption: 'Here is how {product} does {thing}.' },
      analysis,
      brand: null,
    });
    expect(qc.passed).toBe(false);
  });

  it('blocks a near-repeat of a recent post', () => {
    const qc = runQualityControl({
      item: baseItem,
      analysis,
      brand: null,
      recent: [{ hook: baseItem.hook, caption: baseItem.caption }],
    });
    expect(qc.passed).toBe(false);
    expect(qc.findings.some((f) => f.check === 'repetitive')).toBe(true);
  });

  it('does not flag two different posts that share boilerplate', () => {
    const qc = runQualityControl({
      item: baseItem,
      analysis,
      brand: null,
      recent: [
        {
          hook: 'Watch the analytics dashboard update in real time',
          caption: 'A perfectly ordinary caption that says something useful about the product.',
        },
      ],
    });
    expect(qc.passed).toBe(true);
  });

  it('warns on brand words the profile bans', () => {
    const qc = runQualityControl({
      item: { ...baseItem, caption: 'A truly revolutionary way to leverage your workflow.' },
      analysis,
      brand: {
        words_to_avoid: ['revolutionary', 'leverage'],
        words_to_use: [],
        emoji_policy: 'sparing',
      },
    });
    expect(qc.findings.filter((f) => f.check === 'brand_consistency').length).toBeGreaterThan(0);
    expect(qc.requires_human_review).toBe(true);
  });

  it('warns when emoji policy is violated', () => {
    const qc = runQualityControl({
      item: { ...baseItem, caption: 'Nice 🚀 very nice 🎉 so good 🔥' },
      analysis,
      brand: { words_to_avoid: [], words_to_use: [], emoji_policy: 'none' },
    });
    expect(qc.findings.some((f) => f.check === 'brand_consistency')).toBe(true);
  });

  describe('autopilot gating', () => {
    const pass = { passed: true, requires_human_review: false, score: 100, findings: [], checked_at: '' };
    const warned = { ...pass, requires_human_review: true };
    const blocked = { ...pass, passed: false, requires_human_review: true };

    it('never auto-publishes blocked content, even on Full Send', () => {
      expect(canAutoPublish(blocked, 'full_send', 'education', false).allowed).toBe(false);
    });

    it('never auto-publishes in manual mode', () => {
      expect(canAutoPublish(pass, 'manual', 'education', false).allowed).toBe(false);
    });

    it('holds promotional content when the setting says so', () => {
      expect(canAutoPublish(pass, 'hybrid', 'promotion', true).allowed).toBe(false);
      expect(canAutoPublish(pass, 'full_send', 'promotion', true).allowed).toBe(false);
      expect(canAutoPublish(pass, 'full_send', 'promotion', false).allowed).toBe(true);
    });

    it('routes anything with a warning to a human', () => {
      expect(canAutoPublish(warned, 'full_send', 'education', false).allowed).toBe(false);
    });

    it('lets clean, non-promotional content through on Full Send', () => {
      expect(canAutoPublish(pass, 'full_send', 'education', true).allowed).toBe(true);
    });
  });
});
