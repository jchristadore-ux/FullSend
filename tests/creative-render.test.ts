/**
 * The blank post.
 *
 * Thirteen posts reached a real calendar with correct copy and an empty image
 * above it. Nothing in the product noticed, because nothing in the product was
 * asking: a post counted as generated the moment its copy was saved, and the
 * render that followed could fail without leaving a mark.
 *
 * The cause was one step down. Creative is typeset as SVG and rasterised with
 * sharp, which draws text through fontconfig — and fontconfig can only use
 * fonts installed on the machine doing the drawing. A serverless host has
 * none, so the rectangles and rules drew perfectly and every word came out as
 * a replacement box. That image was then stored, and its URL became both the
 * preview and the media Instagram would fetch.
 *
 * These tests hold three things: that this deployment can genuinely draw text,
 * that an image with nothing in it is refused rather than stored, and that a
 * post whose creative failed says so instead of scheduling itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  BUNDLED_FONT_FAMILY,
  MIN_PROBE_COVERAGE,
  assertTextRenderable,
  fontDirectory,
  probeInkCoverage,
  resetFontState,
} from '@/lib/creative/fonts';
import { assertNotBlank, ensurePublicUrl, MIN_IMAGE_STDDEV, publicUrlsFor } from '@/lib/creative/media';
import { hookCard, slideCard, withBundledFallback } from '@/lib/creative/render';
import { materializeCreative, regenerateCreative } from '@/lib/creative/pipeline';
import { paletteFor } from '@/lib/brand/identity';
import { scheduleContent } from '@/lib/scheduler/schedule';
import { assertPublishable } from '@/lib/publish/guard';
import { db } from '@/lib/db/repo';
import { newId, nowIso } from '@/lib/ids';
import { isFullSendError } from '@/lib/errors';
import { createProject, setupContext, teardown, type TestContext } from './helpers';
import type { BrandProfile, ContentItem, ProductAnalysis, Project } from '@/lib/types';

afterEach(() => {
  resetFontState();
  teardown();
});

/* ── Fixtures ───────────────────────────────────────────────────────────── */

async function brandFor(
  ctx: TestContext,
  project: Project,
  overrides: Partial<BrandProfile> = {},
): Promise<BrandProfile> {
  return db().insert(ctx.scope, 'brand_profiles', {
    id: newId(),
    project_id: project.id,
    brand_name: project.name,
    voice: 'Direct',
    tone_attributes: [],
    messaging_pillars: [],
    words_to_use: [],
    words_to_avoid: [],
    ctas: [],
    emoji_policy: 'none',
    terminology: {},
    primary_color: '',
    secondary_color: '',
    accent_color: '',
    background_color: '',
    text_color: '',
    heading_font: '',
    body_font: '',
    logo_url: null,
    logo_dark_url: null,
    icon_style: '',
    design_language: '',
    imagery_style: '',
    graphic_style: '',
    brand_personality: '',
    brand_keywords: [],
    visual_dos: [],
    visual_donts: [],
    content_dos: [],
    content_donts: [],
    identity_sources: {},
    locked_fields: [],
    identity_discovered_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  } as BrandProfile);
}

async function analysisFor(ctx: TestContext, project: Project): Promise<ProductAnalysis> {
  return db().insert(ctx.scope, 'product_analysis', {
    id: newId(),
    project_id: project.id,
    commit_sha: 'abc1234',
    one_liner: 'Does one thing well.',
    what_it_does: 'It does the thing.',
    category: 'productivity',
    features: [],
    not_capabilities: [],
    differentiators: [],
    problem_solved: 'The thing was hard.',
    target_users: [],
    tech_stack: [],
    screens: [],
    confidence: 0.9,
    raw_signals: {},
    created_at: nowIso(),
  } as unknown as ProductAnalysis);
}

async function itemFor(
  ctx: TestContext,
  project: Project,
  overrides: Partial<ContentItem> = {},
): Promise<ContentItem> {
  return db().insert(ctx.scope, 'content_items', {
    id: newId(),
    project_id: project.id,
    campaign_id: null,
    pillar_id: null,
    persona_id: null,
    platform: 'instagram',
    format: 'static',
    hook: 'Nobody warns you there are forty things to rename after the wedding.',
    script: null,
    caption: 'A caption that a founder would be happy to publish under their own name.',
    cta: 'Get the checklist',
    hashtags: ['#namechange'],
    video_plan: null,
    slides: null,
    creative_asset_ids: [],
    status: 'approved',
    generation_state: 'copy_complete',
    generation_error: null,
    dedup_hash: newId(),
    qc: null,
    scheduled_for: new Date(Date.now() + 86_400_000).toISOString(),
    published_at: null,
    origin: 'initial',
    ai_cost_usd: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  } as ContentItem);
}

/* ── The renderer can actually draw ─────────────────────────────────────── */

describe('the deployment can draw text', () => {
  it('ships the fonts it typesets with', () => {
    // Not "a font exists somewhere on the host" — the specific faces that
    // travel with the application, which is the only thing a serverless
    // deployment can rely on.
    expect(fontDirectory()).not.toBeNull();
  });

  it('measures real ink for a real string', async () => {
    const coverage = await probeInkCoverage();
    expect(coverage).toBeGreaterThan(MIN_PROBE_COVERAGE);
  });

  it('passes the pre-flight check rather than throwing', async () => {
    await expect(assertTextRenderable()).resolves.toBeUndefined();
  });

  it('separates typeset text from replacement boxes by a wide margin', async () => {
    /*
     * The number that makes the check decisive. A card drawn with a font
     * covers a sixth of the probe; one drawn without covers half a percent.
     * If that gap ever narrows, this fails before the threshold silently
     * stops discriminating.
     */
    const withFont = await probeInkCoverage();
    expect(withFont).toBeGreaterThan(MIN_PROBE_COVERAGE * 3);
  });
});

describe('font stacks', () => {
  it('names the bundled family before the generic keyword', () => {
    expect(withBundledFallback('Archivo, sans-serif')).toBe(
      `Archivo, ${BUNDLED_FONT_FAMILY}, sans-serif`,
    );
  });

  it('appends it to a stack that ends in a real family', () => {
    expect(withBundledFallback('Archivo')).toBe(`Archivo, ${BUNDLED_FONT_FAMILY}, sans-serif`);
  });

  it('does not repeat itself', () => {
    const once = withBundledFallback(`${BUNDLED_FONT_FAMILY}, sans-serif`);
    expect(withBundledFallback(once)).toBe(once);
  });

  it('gives an empty stack something to draw with', () => {
    expect(withBundledFallback('   ')).toBe(`${BUNDLED_FONT_FAMILY}, sans-serif`);
  });

  it('reaches the rendered card', () => {
    const svg = hookCard({
      hook: 'A hook',
      cta: 'Tap through',
      palette: paletteFor(null),
      size: { w: 1080, h: 1350 },
      footer: 'AfterIDo',
      badge: 'INSTAGRAM',
    });
    expect(svg).toContain(BUNDLED_FONT_FAMILY);
  });
});

/* ── A blank image is refused ───────────────────────────────────────────── */

describe('blank images', () => {
  async function raster(svg: string): Promise<Buffer> {
    return sharp(Buffer.from(svg, 'utf8'), { density: 144 }).jpeg().toBuffer();
  }

  it('accepts a card with words on it', async () => {
    const svg = hookCard({
      hook: 'Nobody warns you there are forty things to rename after the wedding.',
      cta: 'Get the checklist',
      palette: paletteFor(null),
      size: { w: 540, h: 675 },
      footer: 'AfterIDo',
      badge: 'INSTAGRAM',
    });
    await expect(assertNotBlank(await raster(svg))).resolves.toBeUndefined();
  });

  it('refuses a flat field of colour', async () => {
    // What a card looks like when nothing drew: the background, and nothing
    // else. It is a valid JPEG, the right size, and completely useless.
    const empty = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="675"><rect width="540" height="675" fill="#F7F7F5"/></svg>`;
    await expect(assertNotBlank(await raster(empty))).rejects.toMatchObject({
      code: 'creative_blank',
    });
  });

  it('says what to do about it', async () => {
    const empty = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#111111"/></svg>`;
    try {
      await assertNotBlank(await raster(empty));
      throw new Error('should have refused');
    } catch (e) {
      expect(isFullSendError(e) && e.remedy).toContain('Regenerate the creative');
    }
  });

  it('holds a threshold that a real card clears', () => {
    expect(MIN_IMAGE_STDDEV).toBeGreaterThan(0);
  });
});

/* ── Generation state ───────────────────────────────────────────────────── */

describe('generation state', () => {
  it('marks a post complete once its creative exists', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id);
    const brand = await brandFor(ctx, project);
    const analysis = await analysisFor(ctx, project);
    const item = await itemFor(ctx, project);

    const outcome = await materializeCreative(ctx.scope, { project, item, brand, analysis });

    expect(outcome.failed).toBe(false);
    expect(outcome.assets.length).toBeGreaterThan(0);
    expect(outcome.item.generation_state).toBe('complete');
    expect(outcome.item.creative_asset_ids).toHaveLength(outcome.assets.length);
  });

  it('records a failure on the post rather than losing it', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id);
    const other = await createProject(ctx.scope, ctx.user.id, { name: 'Someone else' });
    const analysis = await analysisFor(ctx, project);
    const item = await itemFor(ctx, project);

    // A brand belonging to a different project: the renderer must refuse
    // rather than print one product's identity on another's card.
    const wrongBrand = await brandFor(ctx, other);
    const outcome = await materializeCreative(ctx.scope, {
      project,
      item,
      brand: wrongBrand,
      analysis,
    });

    expect(outcome.failed).toBe(true);
    expect(outcome.item.generation_state).toBe('failed');
    expect(outcome.item.generation_error).toContain('different project');
    // The copy survives. It is real work, and the founder can still use it.
    expect(outcome.item.hook).toBe(item.hook);
  });

  it('holds a failed post for review instead of leaving it approved', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id);
    const other = await createProject(ctx.scope, ctx.user.id, { name: 'Someone else' });
    const analysis = await analysisFor(ctx, project);
    const item = await itemFor(ctx, project, { status: 'approved' });

    const outcome = await materializeCreative(ctx.scope, {
      project,
      item,
      brand: await brandFor(ctx, other),
      analysis,
    });

    expect(outcome.item.status).toBe('review_required');
  });

  it('files the failure where the Control Room reads it', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id);
    const other = await createProject(ctx.scope, ctx.user.id, { name: 'Someone else' });

    await materializeCreative(ctx.scope, {
      project,
      item: await itemFor(ctx, project),
      brand: await brandFor(ctx, other),
      analysis: await analysisFor(ctx, project),
    });

    const errors = await db().find(ctx.scope, 'automation_errors', {
      where: { project_id: project.id },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].scope).toContain('creative:');
    expect(errors[0].remedy).toContain('Regenerate');

    const items = await db().find(ctx.scope, 'content_items', { where: { project_id: project.id } });
    expect(items[0].generation_state).toBe('failed');
  });
});

/* ── Nothing blank gets out ─────────────────────────────────────────────── */

describe('a post with no creative never publishes', () => {
  it('is not scheduled', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id);
    const item = await itemFor(ctx, project, {
      status: 'approved',
      generation_state: 'failed',
      generation_error: 'The rendered creative came out blank',
    });

    const result = await scheduleContent(ctx.scope, project, [item]);

    expect(result.scheduled).toHaveLength(0);
    expect(result.skipped[0].reason).toContain('blank');
  });

  it('is refused at the last gate before Instagram', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id);
    const item = await itemFor(ctx, project, {
      generation_state: 'failed',
      generation_error: 'No fonts on this host',
    });
    const post = await db().insert(ctx.scope, 'scheduled_posts', {
      id: newId(),
      project_id: project.id,
      content_item_id: item.id,
      social_account_id: null,
      platform: 'instagram',
      scheduled_for: nowIso(),
      timezone: 'UTC',
      status: 'scheduled',
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: nowIso(),
      started_at: null,
      platform_container_id: null,
      publish_submitted_at: null,
      published_at: null,
    });

    await expect(
      assertPublishable(ctx.scope, { post, project, content: item }),
    ).rejects.toMatchObject({ code: 'cross_project_block' });
  });
});

/* ── Recovery ───────────────────────────────────────────────────────────── */

describe('regenerating creative', () => {
  it('replaces the assets rather than adding to them', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id);
    const brand = await brandFor(ctx, project);
    const analysis = await analysisFor(ctx, project);
    const item = await itemFor(ctx, project);

    await materializeCreative(ctx.scope, { project, item, brand, analysis });
    const first = await db().find(ctx.scope, 'creative_assets', {
      where: { project_id: project.id, content_item_id: item.id },
    });

    const outcome = await regenerateCreative(ctx.scope, item.id);
    const second = await db().find(ctx.scope, 'creative_assets', {
      where: { project_id: project.id, content_item_id: item.id },
    });

    expect(outcome.failed).toBe(false);
    expect(second).toHaveLength(first.length);
    expect(second.map((a) => a.id)).not.toEqual(first.map((a) => a.id));
  });

  it('brings a failed post back to complete', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id);
    await brandFor(ctx, project);
    await analysisFor(ctx, project);
    const item = await itemFor(ctx, project, {
      generation_state: 'failed',
      generation_error: 'The rendered creative came out blank',
      status: 'review_required',
    });

    const outcome = await regenerateCreative(ctx.scope, item.id);

    expect(outcome.failed).toBe(false);
    expect(outcome.item.generation_state).toBe('complete');
    expect(outcome.item.generation_error).toBeNull();
  });

  it('reports honestly when there is nothing to draw from', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id);
    const item = await itemFor(ctx, project);

    const outcome = await regenerateCreative(ctx.scope, item.id);

    expect(outcome.failed).toBe(true);
    expect(outcome.item.generation_state).toBe('failed');
  });
});

/* ── Every brand draws in its own identity ──────────────────────────────── */

describe('brand-specific creative', () => {
  it('draws two brands differently from the same copy', async () => {
    const ctx = await setupContext();

    const afterIdo = await createProject(ctx.scope, ctx.user.id, { name: 'AfterIDo' });
    const fullsend = await createProject(ctx.scope, ctx.user.id, { name: 'FullSend' });

    const afterIdoBrand = await brandFor(ctx, afterIdo, {
      brand_name: 'AfterIDo',
      primary_color: '#e4572e',
      background_color: '#fffaf6',
      text_color: '#1b1b1f',
      heading_font: 'Fraunces',
      body_font: 'Fraunces',
    });
    const fullsendBrand = await brandFor(ctx, fullsend, {
      brand_name: 'FullSend',
      primary_color: '#ff5a1f',
      background_color: '#08090a',
      text_color: '#f2f2f2',
      heading_font: 'Archivo',
      body_font: 'Archivo',
    });

    await materializeCreative(ctx.scope, {
      project: afterIdo,
      item: await itemFor(ctx, afterIdo),
      brand: afterIdoBrand,
      analysis: await analysisFor(ctx, afterIdo),
    });
    await materializeCreative(ctx.scope, {
      project: fullsend,
      item: await itemFor(ctx, fullsend),
      brand: fullsendBrand,
      analysis: await analysisFor(ctx, fullsend),
    });

    const [a] = await db().find(ctx.scope, 'creative_assets', {
      where: { project_id: afterIdo.id },
    });
    const [f] = await db().find(ctx.scope, 'creative_assets', {
      where: { project_id: fullsend.id },
    });

    expect(a.svg).toContain('#e4572e');
    expect(a.svg).toContain('Fraunces');
    expect(a.svg).toContain('AFTERIDO');
    expect(a.svg).not.toContain('#ff5a1f');

    expect(f.svg).toContain('#ff5a1f');
    expect(f.svg).toContain('Archivo');
    expect(f.svg).not.toContain('#e4572e');
  });

  it('never falls back to another brand when a colour is unknown', () => {
    // The neutral is achromatic on purpose: a card in somebody else's orange
    // is a claim about their product, and a wrong one.
    const palette = paletteFor(null);
    expect(palette.accent.toLowerCase()).not.toBe('#ff5a1f');
  });

  it('typesets a carousel slide in the brand it was given', () => {
    const svg = slideCard({
      headline: 'Six questions',
      body: 'That is all it takes.',
      index: 0,
      total: 6,
      palette: paletteFor({
        primary_color: '#123456',
        secondary_color: '',
        accent_color: '',
        background_color: '#ffffff',
        text_color: '#111111',
        heading_font: 'Fraunces',
        body_font: 'Fraunces',
        logo_url: null,
      }),
      size: { w: 1080, h: 1350 },
      footer: 'AfterIDo',
    });
    expect(svg).toContain('#123456');
    expect(svg).toContain('Fraunces');
  });
});

/* ── Media that a platform could not fetch ──────────────────────────────── */

describe('an asset with no usable media', () => {
  async function assetFor(
    ctx: TestContext,
    project: Project,
    overrides: Record<string, unknown> = {},
  ) {
    return db().insert(ctx.scope, 'creative_assets', {
      id: newId(),
      project_id: project.id,
      content_item_id: null,
      kind: 'image',
      source: 'svg_render',
      mime_type: 'image/svg+xml',
      width: 1080,
      height: 1350,
      url: null,
      storage_path: null,
      svg: null,
      alt_text: 'nothing',
      created_at: nowIso(),
      ...overrides,
    } as never);
  }

  it('is refused rather than published as a dead URL', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id);
    const asset = await assetFor(ctx, project);

    // Neither a URL nor anything to draw. Instagram fetches media itself, so
    // the alternative to failing here is a publish that fails at Meta with an
    // error about the media, which reads as a content problem and is not one.
    await expect(ensurePublicUrl(ctx.scope, asset)).rejects.toMatchObject({
      code: 'media_missing',
    });
  });

  it('passes a URL that already exists straight through', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id);
    const asset = await assetFor(ctx, project, {
      url: 'https://cdn.example.test/shot.png',
      source: 'repo_screenshot',
    });

    await expect(ensurePublicUrl(ctx.scope, asset)).resolves.toBe(
      'https://cdn.example.test/shot.png',
    );
  });

  it('never resolves another project’s asset', async () => {
    const ctx = await setupContext();
    const mine = await createProject(ctx.scope, ctx.user.id, { name: 'AfterIDo' });
    const theirs = await createProject(ctx.scope, ctx.user.id, { name: 'FullSend' });

    const foreign = await assetFor(ctx, theirs, { url: 'https://cdn.example.test/theirs.png' });
    const own = await assetFor(ctx, mine, { url: 'https://cdn.example.test/mine.png' });

    const media = await publicUrlsFor(ctx.scope, mine.id, [foreign.id, own.id]);

    expect(media.images).toEqual(['https://cdn.example.test/mine.png']);
  });
});
