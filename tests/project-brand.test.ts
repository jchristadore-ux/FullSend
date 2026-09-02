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
