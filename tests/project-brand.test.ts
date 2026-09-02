/**
 * One engine, several brands.
 *
 * FullSend markets more than one product at a time, and the two failures that
 * matter here are both invisible until they are public: a post that goes out
 * in the wrong product's colours, and a post that goes out on the wrong
 * product's account. Neither can be retracted.
 *
 * These tests hold both shut. The brand half asserts that identity is *read*
 * from a repository rather than invented, that unknown stays unknown, and that
 * a founder's correction survives re-analysis. The publishing half asserts
 * that every row in a publish agrees on which project it belongs to, and that
 * a scheduled post keeps the destination it was given.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverBrandIdentity,
  extractColorTokens,
  extractFontStacks,
} from '@/lib/brand/discover';
import {
  NEUTRAL_FONT,
  NEUTRAL_PALETTE,
  applyRespectingLocks,
  contrastRatio,
  identityFrom,
  identityGaps,
  identityPatch,
  lockFields,
  paletteFor,
} from '@/lib/brand/identity';
import { assertPublishable, pinDestination } from '@/lib/publish/guard';
import { publishScheduledPost } from '@/lib/publish/publish';
import { hookCard } from '@/lib/creative/render';
import { runQualityControl } from '@/lib/qc/check';
import { db } from '@/lib/db/repo';
import { systemScope } from '@/lib/db';
import { newId, nowIso } from '@/lib/ids';
import { isFullSendError } from '@/lib/errors';
import { completeConnection } from '@/lib/social/connections';
import {
  createProject,
  fakeGitHubClient,
  setupContext,
  teardown,
  type TestContext,
} from './helpers';
import type { BrandProfile, ContentItem, Project, ScheduledPost } from '@/lib/types';

afterEach(teardown);

/* ── Reading an identity out of a repository ────────────────────────────── */

describe('brand discovery reads the repository', () => {
  const GLOBALS = `
    :root {
      --brand-primary: #1A73E8;
      --color-secondary: #34A853;
      --accent: #FBBC04;
      --background: #FFFFFF;
      --foreground: #202124;
      --font-heading: 'Playfair Display', Georgia, serif;
    }
    body { font-family: 'Inter', system-ui, sans-serif; }
  `;

  function repoWithStyles() {
    return fakeGitHubClient({
      owner: 'acme',
      name: 'playpal',
      files: [
        { path: 'package.json', content: '{"name":"playpal","dependencies":{}}' },
        { path: 'src/app/globals.css', content: GLOBALS },
        { path: 'public/logo.svg', content: '<svg/>', size: 900 },
        { path: 'public/logo-dark.svg', content: '<svg/>', size: 900 },
      ],
    });
  }

  it('extracts named colour tokens with their values', () => {
    const tokens = extractColorTokens(GLOBALS);
    const byName = Object.fromEntries(tokens.map((t) => [t.name, t.value]));
    expect(byName['brand-primary']).toBe('#1a73e8');
    expect(byName['color-secondary']).toBe('#34a853');
    expect(byName.accent).toBe('#fbbc04');
  });

  it('expands shorthand hex and drops the alpha channel', () => {
    const tokens = extractColorTokens('--brand: #abc; --ink: #11223344;');
    expect(tokens).toEqual([
      { name: 'brand', value: '#aabbcc' },
      // Alpha is a rendering decision, not part of a brand colour.
      { name: 'ink', value: '#112233' },
    ]);
  });

  it('keeps the whole font stack, not just the first family', () => {
    const stacks = extractFontStacks(GLOBALS);
    expect(stacks).toContain('Inter, system-ui, sans-serif');
    expect(stacks).toContain('Playfair Display, Georgia, serif');
  });

  it('assigns each colour to the slot its name claims', async () => {
    const identity = await discoverBrandIdentity(
      { owner: 'acme', name: 'playpal' },
      repoWithStyles(),
      'main',
      [
        { path: 'src/app/globals.css', type: 'blob', size: GLOBALS.length },
        { path: 'public/logo.svg', type: 'blob', size: 900 },
        { path: 'public/logo-dark.svg', type: 'blob', size: 900 },
      ],
    );

    expect(identity.primary_color?.value).toBe('#1a73e8');
    expect(identity.secondary_color?.value).toBe('#34a853');
    expect(identity.accent_color?.value).toBe('#fbbc04');
    expect(identity.background_color?.value).toBe('#ffffff');
    expect(identity.text_color?.value).toBe('#202124');
    // Every answer names the file it came from, so a wrong one can be traced.
    expect(identity.primary_color?.source).toBe('src/app/globals.css');
  });

  it('separates display type from running text', async () => {
    const identity = await discoverBrandIdentity(
      { owner: 'acme', name: 'playpal' },
      repoWithStyles(),
      'main',
      [{ path: 'src/app/globals.css', type: 'blob', size: GLOBALS.length }],
    );
    expect(identity.heading_font?.value).toBe('Playfair Display, Georgia, serif');
    expect(identity.body_font?.value).toBe('Inter, system-ui, sans-serif');
  });

  it('prefers the light mark and records the dark one separately', async () => {
    const identity = await discoverBrandIdentity(
      { owner: 'acme', name: 'playpal' },
      repoWithStyles(),
      'main',
      [
        { path: 'public/logo.svg', type: 'blob', size: 900 },
        { path: 'public/logo-dark.svg', type: 'blob', size: 900 },
      ],
    );
    expect(identity.logo_url?.value).toContain('public/logo.svg');
    expect(identity.logo_dark_url?.value).toContain('public/logo-dark.svg');
  });

  it('ignores a favicon, which is not a logo', async () => {
    const identity = await discoverBrandIdentity(
      { owner: 'acme', name: 'playpal' },
      fakeGitHubClient({ files: [{ path: 'public/favicon-logo.png', size: 400 }] }),
      'main',
      [{ path: 'public/favicon-logo.png', type: 'blob', size: 400 }],
    );
    expect(identity.logo_url).toBeUndefined();
  });

  /*
   * The load-bearing one. A repository that states nothing must produce
   * nothing — the entire point of this module is that a founder can tell a
   * reading from a guess, and a guess presented as a reading is the failure it
   * was written to prevent.
   */
  it('leaves a silent repository unknown rather than guessing', async () => {
    const identity = await discoverBrandIdentity(
      { owner: 'acme', name: 'plain' },
      fakeGitHubClient({ files: [{ path: 'README.md', content: '# plain' }] }),
      'main',
      [{ path: 'README.md', type: 'blob', size: 12 }],
    );

    expect(identity.primary_color).toBeUndefined();
    expect(identity.heading_font).toBeUndefined();
    expect(identity.logo_url).toBeUndefined();
    expect(identity.evidence.unresolved).toContain('primary_color');
    expect(identity.evidence.unresolved).toContain('logo_url');
    // And in particular: nothing of FullSend's leaks in as a stand-in.
    expect(JSON.stringify(identity).toLowerCase()).not.toContain('ff5a1f');
  });

  it('lets a token file overrule a component stylesheet', async () => {
    const files = [
      { path: 'src/components/Button.css', type: 'blob' as const, size: 200 },
      { path: 'src/styles/theme.css', type: 'blob' as const, size: 200 },
    ];
    const identity = await discoverBrandIdentity(
      { owner: 'acme', name: 'ranked' },
      fakeGitHubClient({
        files: [
          { path: 'src/components/Button.css', content: '--primary: #ff0000;' },
          { path: 'src/styles/theme.css', content: '--primary: #00ff00;' },
        ],
      }),
      'main',
      files,
    );
    expect(identity.primary_color?.value).toBe('#00ff00');
    expect(identity.primary_color?.source).toBe('src/styles/theme.css');
  });
});

/* ── The palette a card is actually drawn with ──────────────────────────── */

describe('the render palette', () => {
  const empty = {
    primary_color: '',
    secondary_color: '',
    accent_color: '',
    background_color: '',
    text_color: '',
    heading_font: '',
    body_font: '',
    logo_url: null,
  };

  it('falls back to a neutral, never to FullSend', () => {
    const palette = paletteFor(empty);
    expect(palette.accent).toBe(NEUTRAL_PALETTE.accent);
    expect(palette.bg).toBe(NEUTRAL_PALETTE.bg);
    expect(palette.headingFont).toBe(NEUTRAL_FONT);
    expect(palette.accent.toLowerCase()).not.toBe('#ff5a1f');
  });

  it('keeps a stated colour even when the rest is missing', () => {
    const palette = paletteFor({ ...empty, primary_color: '#1a73e8' });
    expect(palette.accent).toBe('#1a73e8');
    expect(palette.bg).toBe(NEUTRAL_PALETTE.bg);
  });

  it('overrides a stated text colour that cannot be read on the background', () => {
    // A product may only ever put these two together with a container between
    // them. On a full-bleed card there is nothing between them.
    const palette = paletteFor({ ...empty, background_color: '#ffffff', text_color: '#fdfdfd' });
    expect(contrastRatio(palette.fg, palette.bg)).toBeGreaterThan(4.5);
  });

  it('uses one typeface for both roles when only one was found', () => {
    const palette = paletteFor({ ...empty, body_font: 'Inter, sans-serif' });
    expect(palette.headingFont).toBe('Inter, sans-serif');
    expect(palette.bodyFont).toBe('Inter, sans-serif');
  });

  it('draws a card in the project’s colours and type', () => {
    const svg = hookCard({
      hook: 'Ship it before you are ready',
      cta: 'Try PlayPal',
      palette: paletteFor({
        ...empty,
        primary_color: '#1a73e8',
        background_color: '#ffffff',
        heading_font: 'Playfair Display, serif',
        body_font: 'Inter, sans-serif',
      }),
      size: { w: 1080, h: 1350 },
      footer: 'PlayPal',
      badge: 'INSTAGRAM',
    });

    expect(svg).toContain('#1a73e8');
    expect(svg).toContain('Playfair Display, serif');
    expect(svg).toContain('Inter, sans-serif');
    // The two things that used to be baked into every card FullSend produced.
    expect(svg.toLowerCase()).not.toContain('ff5a1f');
    expect(svg).not.toContain('Archivo');
  });

  it('cannot be made to break out of an SVG attribute by a font stack', () => {
    const svg = hookCard({
      hook: 'hook',
      cta: 'cta',
      palette: paletteFor({ ...empty, body_font: 'Evil"><script>alert(1)</script>' }),
      size: { w: 1080, h: 1350 },
      footer: 'x',
      badge: 'B',
    });
    expect(svg).not.toContain('<script>');
  });
});

/* ── Locks: a founder's correction is final ─────────────────────────────── */

describe('hand corrections survive re-analysis', () => {
  const discovered = {
    evidence: { style_files: [], color_tokens: [], font_families: [], logo_candidates: [], unresolved: [] },
    primary_color: { value: '#00ff00', source: 'theme.css' },
    body_font: { value: 'Inter, sans-serif', source: 'theme.css' },
  };

  it('writes a discovered field when nothing is locked', () => {
    const { patch, sources, respected } = identityPatch(discovered, { locked_fields: [] });
    expect(patch.primary_color).toBe('#00ff00');
    expect(sources.primary_color).toBe('theme.css');
    expect(respected).toEqual([]);
  });

  it('skips a field the founder has corrected', () => {
    const { patch, respected } = identityPatch(discovered, { locked_fields: ['primary_color'] });
    expect(patch.primary_color).toBeUndefined();
    expect(patch.body_font).toBe('Inter, sans-serif');
    expect(respected).toEqual(['primary_color']);
  });

  it('omits a field the repository did not answer rather than blanking it', () => {
    // Otherwise a later analysis that read a truncated tree would erase what an
    // earlier, complete one had found.
    const { patch } = identityPatch(
      { evidence: discovered.evidence, primary_color: { value: '#00ff00', source: 't' } },
      null,
    );
    expect('logo_url' in patch).toBe(false);
    expect('heading_font' in patch).toBe(false);
  });

  it('drops locked keys from any patch, not just a discovered one', () => {
    const out = applyRespectingLocks({ locked_fields: ['voice'] }, {
      voice: 'model wrote this',
      audience: 'model wrote this too',
    });
    expect(out).toEqual({ audience: 'model wrote this too' });
  });

  it('locks only fields a founder is allowed to own', () => {
    const locked = lockFields(null, ['primary_color', 'locked_fields', 'id', 'voice']);
    expect(locked.sort()).toEqual(['primary_color', 'voice']);
  });

  it('reads back nothing from an analysis predating discovery', () => {
    expect(identityFrom({ raw_signals: {} } as never)).toBeNull();
    expect(identityFrom(null)).toBeNull();
  });

  it('names the gaps rather than leaving a neutral card looking deliberate', () => {
    const gaps = identityGaps({
      primary_color: '',
      heading_font: '',
      body_font: '',
      logo_url: null,
    } as BrandProfile);
    expect(gaps).toHaveLength(3);
    expect(gaps.join(' ')).toContain('colour');
  });
});

/* ── Cross-project safety ───────────────────────────────────────────────── */

interface Fixture {
  ctx: TestContext;
  project: Project;
  content: ContentItem;
  post: ScheduledPost;
  accountId: string;
}

/** A project with an account, one content item and one scheduled post. */
async function fixture(ctx: TestContext, name: string): Promise<Fixture> {
  const scope = systemScope('test');
  const project = await createProject(ctx.scope, ctx.user.id, {
    name,
    slug: name.toLowerCase(),
  });

  const account = await completeConnection(
    scope,
    project,
    'instagram',
    { accessToken: `token-${name}`, refreshToken: null, expiresAt: null, refreshExpiresAt: null, scopes: [] },
    {
      externalId: `ig-${name}`,
      username: `${name.toLowerCase()}_official`,
      displayName: name,
      avatarUrl: null,
      followers: 0,
      metadata: {},
    },
  );

  const content = await db().insert(scope, 'content_items', {
    id: newId(),
    project_id: project.id,
    campaign_id: null,
    pillar_id: null,
    persona_id: null,
    platform: 'instagram',
    format: 'static',
    hook: `${name} hook`,
    script: null,
    caption: `${name} caption`,
    cta: 'Try it',
    hashtags: [],
    video_plan: null,
    slides: null,
    creative_asset_ids: [],
    status: 'scheduled',
    dedup_hash: `${name}-hash`,
    qc: null,
    scheduled_for: nowIso(),
    published_at: null,
    origin: 'initial',
    ai_cost_usd: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  const post = await db().insert(scope, 'scheduled_posts', {
    id: newId(),
    project_id: project.id,
    content_item_id: content.id,
    social_account_id: account.id,
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

  return { ctx, project, content, post, accountId: account.id };
}

async function refusal(fn: () => Promise<unknown>): Promise<{ message: string; remedy: string | null }> {
  try {
    await fn();
  } catch (e) {
    if (!isFullSendError(e)) throw e;
    expect(e.code).toBe('cross_project_block');
    // Never retryable: a mismatch retried is a mismatch that eventually gets lucky.
    expect(e.retryable).toBe(false);
    return { message: e.message, remedy: e.remedy };
  }
  throw new Error('expected the publish to be refused');
}

describe('a post can only ever publish to its own project', () => {
  it('lets a well-formed post through', async () => {
    const ctx = await setupContext();
    const { project, content, post, accountId } = await fixture(ctx, 'AfterIDo');
    const scope = systemScope('test');

    const target = await assertPublishable(scope, { post, project, content });
    expect(target.account.id).toBe(accountId);
    expect(target.account.username).toBe('afterido_official');
  });

  it('refuses content belonging to another project', async () => {
    const ctx = await setupContext();
    const after = await fixture(ctx, 'AfterIDo');
    const play = await fixture(ctx, 'PlayPal');
    const scope = systemScope('test');

    // PlayPal's content, on AfterIDo's post. Nothing in the tenant scope
    // catches this: background work legitimately crosses projects.
    const { message } = await refusal(() =>
      assertPublishable(scope, {
        post: after.post,
        project: after.project,
        content: play.content,
      }),
    );
    expect(message).toContain('different project');
  });

  it('refuses a post whose platform does not match its content', async () => {
    const ctx = await setupContext();
    const { project, content, post } = await fixture(ctx, 'FlipPulse');
    const scope = systemScope('test');

    await db().update(scope, 'content_items', content.id, { platform: 'tiktok' });
    const written = await db().get(scope, 'content_items', content.id);

    const { message } = await refusal(() =>
      assertPublishable(scope, { post, project, content: written! }),
    );
    expect(message).toContain('written for tiktok');
  });

  /*
   * The one that motivated the guard. A post is scheduled to one account; the
   * founder later swaps the project onto a different account. The queued post
   * must not follow.
   */
  it('refuses to follow a project onto a different account', async () => {
    const ctx = await setupContext();
    const { project, content, post } = await fixture(ctx, 'AfterIDo');
    const scope = systemScope('test');

    // The account the post was pinned to is gone; a new one has taken its place.
    await db().remove(scope, 'social_accounts', post.social_account_id!);
    await completeConnection(
      scope,
      project,
      'instagram',
      { accessToken: 't2', refreshToken: null, expiresAt: null, refreshExpiresAt: null, scopes: [] },
      {
        externalId: 'ig-new',
        username: 'somebody_else',
        displayName: 'Somebody Else',
        avatarUrl: null,
        followers: 0,
        metadata: {},
      },
    );

    const { message, remedy } = await refusal(() =>
      assertPublishable(scope, { post, project, content }),
    );
    expect(message).toContain('no longer exists');
    expect(remedy).toContain('will not silently send it to a different account');
  });

  it('refuses when the project has no account at all', async () => {
    const ctx = await setupContext();
    const { project, content, post } = await fixture(ctx, 'PlayPal');
    const scope = systemScope('test');

    await db().update(scope, 'scheduled_posts', post.id, { social_account_id: null });
    await db().remove(scope, 'social_accounts', post.social_account_id!);
    const unpinned = await db().get(scope, 'scheduled_posts', post.id);

    const { message, remedy } = await refusal(() =>
      assertPublishable(scope, { post: unpinned!, project, content }),
    );
    expect(message).toContain('no instagram account connected');
    expect(remedy).toContain('no fallback');
  });

  it('refuses to publish to a disconnected account rather than finding another', async () => {
    const ctx = await setupContext();
    const { project, content, post } = await fixture(ctx, 'FlipPulse');
    const scope = systemScope('test');

    await db().update(scope, 'social_accounts', post.social_account_id!, {
      status: 'disconnected',
    });

    const { message } = await refusal(() => assertPublishable(scope, { post, project, content }));
    expect(message).toContain('disconnected');
  });

  it('pins an unpinned post so it can never resolve differently twice', async () => {
    const ctx = await setupContext();
    const { project, content, post, accountId } = await fixture(ctx, 'AfterIDo');
    const scope = systemScope('test');

    await db().update(scope, 'scheduled_posts', post.id, { social_account_id: null });
    const unpinned = (await db().get(scope, 'scheduled_posts', post.id))!;

    const target = await assertPublishable(scope, { post: unpinned, project, content });
    await pinDestination(scope, unpinned, target.account);

    const after = await db().get(scope, 'scheduled_posts', post.id);
    expect(after!.social_account_id).toBe(accountId);
  });

  /*
   * The guard reached through the real publisher, not called directly.
   *
   * `assertPublishable` being correct is worth nothing if `publishScheduledPost`
   * can reach Instagram without consulting it, so this asserts the outcome of an
   * actual publish attempt: refused, recorded, and — the part that matters — no
   * post on the platform.
   */
  it('blocks a cross-project publish through the publisher itself', async () => {
    const ctx = await setupContext();
    const after = await fixture(ctx, 'AfterIDo');
    const play = await fixture(ctx, 'PlayPal');
    const scope = systemScope('test');

    // PlayPal's content attached to AfterIDo's scheduled post.
    await db().update(scope, 'scheduled_posts', after.post.id, {
      content_item_id: play.content.id,
    });

    const outcome = await publishScheduledPost(scope, after.post.id);
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('different project');

    // Nothing reached a platform, on either project.
    const published = await db().find(scope, 'published_posts', {});
    expect(published).toHaveLength(0);

    // And the refusal is durable and legible rather than a silent stall.
    const stored = await db().get(scope, 'scheduled_posts', after.post.id);
    expect(stored!.status).toBe('failed');
    expect(stored!.next_attempt_at).toBeNull();
  });

  it('keeps three projects' + ' destinations entirely separate', async () => {
    const ctx = await setupContext();
    const after = await fixture(ctx, 'AfterIDo');
    const play = await fixture(ctx, 'PlayPal');
    const flip = await fixture(ctx, 'FlipPulse');
    const scope = systemScope('test');

    const targets = await Promise.all(
      [after, play, flip].map((f) =>
        assertPublishable(scope, { post: f.post, project: f.project, content: f.content }),
      ),
    );

    const usernames = targets.map((t) => t.account.username);
    expect(usernames).toEqual(['afterido_official', 'playpal_official', 'flippulse_official']);
    expect(new Set(targets.map((t) => t.account.id)).size).toBe(3);
  });
});

/**
 * Composed content never reaches a feed unseen.
 *
 * `generateObject` falls back to the deterministic composer when a provider
 * call fails, rather than losing the run. For a marketing plan that is the
 * right trade — it is scaffolding a founder reviews. For content it is not,
 * and this is how we learned the difference: a provider timeout composed an
 * AfterIDo carousel reading "Start smaller than you think" / "Automate the
 * repeat, not the decision" / "Measure one thing", body "Applies directly to
 * the name-change order." four times over, and autopilot published it to a
 * real Instagram account.
 *
 * Quality control cannot catch that. It looks for false claims and AI slop,
 * and none of those sentences is either — they are simply empty, and emptiness
 * is not a property of a sentence you can test for. Provenance is.
 */
describe('content composed from templates is held for a human', () => {
  it('composes generic filler when the provider fails, and says so', async () => {
    const { DeterministicProvider } = await import('@/lib/ai/deterministic-provider');
    const provider = new DeterministicProvider();

    const res = await provider.complete({
      task: 'content.batch',
      tier: 'standard',
      system: '',
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            context: {
              project_name: 'AfterIDo',
              analysis: { category: 'Life admin app', features: [], screens: [], differentiators: [] },
              brand: { ctas: ['Get AfterIDo'] },
              briefs: [
                { seed: 's', platform: 'instagram', format: 'carousel', pillar_type: 'education', topic: 'the name-change order' },
              ],
            },
          }),
        },
      ],
    } as never);

    const item = JSON.parse(res.text).items[0];
    // Structurally valid — which is exactly why nothing downstream stopped it.
    expect(item.slides.length).toBeGreaterThan(0);
    expect(item.slides.every((s: { headline: string }) => s.headline.length > 0)).toBe(true);

    /*
     * Note what is no longer asserted here. This used to check that the bodies
     * repeated, because they did: four slides of "Applies directly to {topic}."
     * That is fixed — the composer now builds education slides from the
     * product's own feature list — so asserting it would be asserting the bug.
     *
     * What survives is the property the hold actually keys on: templates are
     * generic by construction however well written, so the provider names
     * itself and the caller decides. "The composer never writes what quality
     * control blocks" below is the stronger replacement.
     */
    expect(res.provider).toBe('deterministic');
  });

  it('flags a live provider failing over to templates, and only that', async () => {
    const { setProvider, generateObject } = await import('@/lib/ai/client');
    const { contentBatchSchema } = await import('@/lib/schemas');

    /*
     * A configured, live provider that returns unusable JSON — the shape of
     * the failure that published the AfterIDo carousel. `generateObject`
     * composes rather than losing the run, and must say that it did.
     */
    const failing = {
      name: 'scripted',
      live: true,
      modelFor: () => 'scripted-model',
      async complete() {
        return {
          text: '{"nothing":"usable"}',
          model: 'scripted-model',
          provider: 'scripted',
          usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 },
          costUsd: 0.001,
          cacheHit: false,
        };
      },
    };

    setProvider(failing as never);
    const degradedRun = await generateObject({
      task: 'content.batch',
      system: '',
      brief: 'one post',
      context: {
        project_name: 'AfterIDo',
        analysis: { category: 'app', features: [], screens: [], differentiators: [] },
        briefs: [{ seed: 's', platform: 'instagram', format: 'static', pillar_type: 'education', topic: 'x' }],
      },
      schema: contentBatchSchema,
      noCache: true,
    });

    // The flag is the whole mechanism: without it nothing downstream can tell
    // a composed post from a written one, and autopilot publishes both.
    expect(degradedRun.degraded).toBe(true);
    expect(degradedRun.model).toContain('deterministic');

    /*
     * And the narrower half of the claim. Running deliberately without an API
     * key puts the install in mock mode: the composer *is* the provider, that
     * is the operator's choice, and it is not a degradation. Conflating the
     * two would hold every post on every no-key install, which is what the
     * first version of this change did.
     */
    setProvider(null);
    const mockRun = await generateObject({
      task: 'content.batch',
      system: '',
      brief: 'one post',
      context: {
        project_name: 'AfterIDo',
        analysis: { category: 'app', features: [], screens: [], differentiators: [] },
        briefs: [{ seed: 's2', platform: 'instagram', format: 'static', pillar_type: 'education', topic: 'y' }],
      },
      schema: contentBatchSchema,
      noCache: true,
    });
    expect(mockRun.degraded).toBe(false);
  });
});

/**
 * The hold itself, through the real generator.
 *
 * The flag test above passes whether or not anything acts on the flag — it
 * only proves `generateObject` reports the degradation. This one goes through
 * `generateContent` and asserts the post that comes out cannot publish, which
 * is the property that was actually missing when the AfterIDo carousel went
 * live.
 */
describe('a degraded batch cannot reach a feed', () => {
  const FAILING_LIVE_PROVIDER = {
    name: 'scripted',
    live: true,
    modelFor: () => 'scripted-model',
    async complete() {
      return {
        text: '{"nothing":"usable"}',
        model: 'scripted-model',
        provider: 'scripted',
        usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 },
        costUsd: 0.001,
        cacheHit: false,
      };
    },
  };

  async function generateOnePost(provider: unknown | null, format: 'carousel' | 'static' = 'carousel') {
    const ctx = await setupContext();
    const { setProvider } = await import('@/lib/ai/client');
    const { generateContent } = await import('@/lib/content/generate');
    const { analyzeProduct } = await import('@/lib/analysis/analyze');
    const { buildStrategy, ensureBrandProfile, approveStrategy } = await import('@/lib/strategy/build');

    const project = await createProject(ctx.scope, ctx.user.id, { autopilot_mode: 'full_send' });

    // Build the prerequisites on the composer, which is the normal test path.
    setProvider(null);
    const analyzed = await analyzeProduct(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });
    const built = await buildStrategy(ctx.scope, project, analyzed.analysis);
    const { brand } = await ensureBrandProfile(ctx.scope, project, analyzed.analysis, built.strategy);
    const strategy = await approveStrategy(ctx.scope, built.strategy.id);

    // Only now install the provider under test, so the failure lands on the
    // content call rather than on the setup.
    setProvider(provider as never);
    const result = await generateContent(ctx.scope, {
      project,
      analysis: analyzed.analysis,
      brand,
      strategy,
      personas: [],
      pillars: built.pillars,
      campaigns: built.campaigns,
      slots: [
        {
          platform: 'instagram' as const,
          format,
          pillarType: 'education' as const,
          at: new Date(Date.now() + 86_400_000),
        },
      ],
    });
    setProvider(null);
    return { ctx, result };
  }

  it('holds the post for review instead of approving it', async () => {
    const { result } = await generateOnePost(FAILING_LIVE_PROVIDER);

    expect(result.created).toHaveLength(1);
    const post = result.created[0];
    // Full send mode would otherwise have approved this and scheduled it.
    expect(post.status).toBe('review_required');
    expect(post.status).not.toBe('approved');
  });

  it('tells the founder why, rather than leaving it to be discovered', async () => {
    const { ctx, result } = await generateOnePost(FAILING_LIVE_PROVIDER);
    expect(result.created.length).toBeGreaterThan(0);

    const notifications = await db().find(ctx.scope, 'notifications', {
      where: { user_id: ctx.user.id },
    });
    const held = notifications.find((n) => n.title.includes('rewriting'));
    expect(held).toBeTruthy();
    expect(held!.body).toContain('provider failed');
  });

  it('leaves a deliberate no-key install publishing as before', async () => {
    /*
     * Mock mode is a choice, not a degradation. Holding here would stop every
     * no-key install dead, which is what the first version of this did.
     *
     * A static post rather than a carousel, deliberately: the composer's
     * carousels repeat their slide bodies and are now blocked by quality
     * control on their own merits, which is correct and a separate gate. What
     * this asserts is only that the `degraded` hold does not fire in mock mode.
     */
    const { result } = await generateOnePost(null, 'static');
    expect(result.created.length).toBeGreaterThan(0);
    expect(result.created.some((c) => c.status === 'approved')).toBe(true);
  });
});

/**
 * The gate that catches what already exists.
 *
 * Holding newly generated content fixes the future. It does nothing about
 * posts already sitting at `scheduled` from before the fix — and those publish
 * on their own. Quality control re-runs at publish time, so a rule here
 * catches them without touching a single row.
 *
 * Every other check reads the hook, the caption and the CTA. Nothing read
 * inside the slides, which is how a carousel passed every check while its
 * slides said nothing.
 */
describe('quality control reads inside a carousel', () => {
  function carousel(slides: { headline: string; body: string }[]) {
    return {
      platform: 'instagram' as const,
      format: 'carousel' as const,
      hook: 'You are doing the name-change order the hard way',
      caption: 'A short caption that is otherwise perfectly fine.',
      cta: 'Get AfterIDo',
      hashtags: ['#namechange'],
      video_plan: null,
      slides,
    };
  }

  it('blocks the carousel that actually published', () => {
    // Reproduced from the composer, verbatim.
    const qc = runQualityControl({
      item: carousel([
        { headline: '5 things about the name-change order', body: 'Swipe →' },
        { headline: '1. Start smaller than you think', body: 'Applies directly to the name-change order.' },
        { headline: '2. Automate the repeat, not the decision', body: 'Applies directly to the name-change order.' },
        { headline: '3. Measure one thing', body: 'Applies directly to the name-change order.' },
        { headline: '4. Ship before it feels ready', body: 'Applies directly to the name-change order.' },
        { headline: "That's it.", body: 'AfterIDo does all of this for you.' },
      ]),
      analysis: null,
      brand: null,
    });

    expect(qc.passed).toBe(false);
    const finding = qc.findings.find((f) => f.check === 'repetitive' && f.severity === 'block');
    expect(finding).toBeTruthy();
    expect(finding!.message).toContain('repeats itself');
  });

  it('leaves a carousel that says six different things alone', () => {
    const qc = runQualityControl({
      item: carousel([
        { headline: 'Start with the SSA', body: 'Every other agency checks this record first.' },
        { headline: 'Then the DMV', body: 'They want the updated Social Security record, not the licence.' },
        { headline: 'Passport next', body: 'It takes the longest, so start it before you need it.' },
        { headline: 'Then the banks', body: 'Most will do it in-branch with the new licence.' },
        { headline: 'Employer and payroll', body: 'This one changes your W-2, so it is not optional.' },
        { headline: 'AfterIDo tracks all of it', body: 'In the order that actually works.' },
      ]),
      analysis: null,
      brand: null,
    });

    expect(qc.findings.some((f) => f.check === 'repetitive')).toBe(false);
  });

  it('does not punish a short carousel for echoing one line', () => {
    // Two slides sharing a call to action is a style, not a failure.
    const qc = runQualityControl({
      item: carousel([
        { headline: 'The order matters', body: 'Start with the SSA.' },
        { headline: 'Get it right once', body: 'Get AfterIDo.' },
        { headline: 'Stop re-doing trips', body: 'Get AfterIDo.' },
      ]),
      analysis: null,
      brand: null,
    });
    // 3 slides, 2 distinct: 2*2 = 4 > 3, so it passes.
    expect(qc.findings.some((f) => f.check === 'repetitive')).toBe(false);
  });
});

/**
 * The composer and the gate, held together.
 *
 * These two were written a day apart and did not agree: the composer produced
 * education carousels with four identical slide bodies, and the quality gate
 * blocks exactly that. Nothing tied them, so the disagreement surfaced only in
 * the end-to-end run — and only on some days, because which post lands in
 * which slot depends on the wall clock. A change whose test outcome depends on
 * the date is a change that has not really been tested.
 *
 * This is the invariant that keeps them honest, and it does not care what day
 * it is: whatever the composer writes must survive the gate the product
 * publishes through.
 */
describe('the composer never writes what quality control blocks', () => {
  const PILLARS = [
    'education',
    'product_demo',
    'entertainment',
    'social_proof',
    'promotion',
  ] as const;

  async function compose(pillarType: string, features: { name: string; description: string }[]) {
    const { DeterministicProvider } = await import('@/lib/ai/deterministic-provider');
    const res = await new DeterministicProvider().complete({
      task: 'content.batch',
      tier: 'standard',
      system: '',
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            context: {
              project_name: 'AfterIDo',
              analysis: {
                category: 'Life admin app',
                features,
                screens: [],
                differentiators: [],
                problem_solved: 'doing it by hand',
              },
              brand: { ctas: ['Get AfterIDo'] },
              briefs: [
                {
                  seed: `seed-${pillarType}`,
                  platform: 'instagram',
                  format: 'carousel',
                  pillar_type: pillarType,
                  topic: 'the name-change order',
                },
              ],
            },
          }),
        },
      ],
    } as never);
    return JSON.parse(res.text).items[0];
  }

  const RICH = [
    { name: 'Ordered task list', description: 'Every agency in the order that actually works.' },
    { name: 'Pre-filled forms', description: 'Your details, already entered.' },
    { name: 'Progress tracking', description: 'What is done and what is next.' },
  ];

  for (const pillar of PILLARS) {
    it(`passes its own gate for a ${pillar} carousel`, async () => {
      const item = await compose(pillar, RICH);

      /*
       * Distinct bodies, asserted directly rather than inferred from the gate
       * passing. The gate's threshold is a ratio, so a carousel whose slide
       * count happened to come out small could carry a repeat and still slip
       * through — which is exactly what the old composer did on some seeds.
       * The invariant is that no two slides say the same thing, and that does
       * not depend on the seed.
       */
      const bodies = item.slides.map((s: { body: string }) => s.body.trim().toLowerCase());
      expect(new Set(bodies).size).toBe(bodies.length);

      const blocked = runQualityControl({ item, analysis: null, brand: null }).findings.filter(
        (f) => f.severity === 'block',
      );
      expect(blocked).toEqual([]);
    });
  }

  it('passes even when the analysis found no feature descriptions', async () => {
    // The padding case: without descriptions the body has to be built from
    // something that still differs per slide.
    const item = await compose('education', [
      { name: 'Ordered task list', description: '' },
      { name: 'Pre-filled forms', description: '' },
      { name: 'Progress tracking', description: '' },
    ]);
    const bodies = item.slides.map((s: { body: string }) => s.body.trim().toLowerCase());
    expect(new Set(bodies).size).toBe(bodies.length);
    expect(runQualityControl({ item, analysis: null, brand: null }).findings
      .filter((f) => f.severity === 'block')).toEqual([]);
  });

  it('writes a shorter carousel rather than padding a thin analysis', async () => {
    // One feature is not a list. Inventing three more to fill slides is the
    // failure this whole area exists to prevent.
    const item = await compose('education', [{ name: 'Ordered task list', description: 'The order.' }]);
    expect(item.slides.length).toBeGreaterThanOrEqual(2);
    const bodies = item.slides.map((s: { body: string }) => s.body.trim().toLowerCase());
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  it('builds education slides from the product, not from stock advice', async () => {
    const item = await compose('education', RICH);
    const text = JSON.stringify(item.slides);
    // The four aphorisms that actually published.
    expect(text).not.toContain('Start smaller than you think');
    expect(text).not.toContain('Automate the repeat');
    expect(text).not.toContain('Measure one thing');
    expect(text).not.toContain('Ship before it feels ready');
    // Replaced by the product's own verified features.
    expect(text).toContain('Ordered task list');
    expect(text).toContain('Pre-filled forms');
  });
});
