/**
 * One Meta application, many Instagram accounts.
 *
 * The first account connected while the Meta app was in Development Mode,
 * which works for anybody holding a role on the app. The second was refused
 * with "insufficient developer role", and the refusal read as a problem with
 * the account — so the obvious next move was to run the whole developer
 * runbook again and add that account as a tester. That does not scale past a
 * handful of brands, and it is not what Meta is asking for: the application is
 * simply not open to the public yet, and taking it Live once fixes every
 * account at the same time.
 *
 * These tests hold the architecture that follows from that:
 *
 *   • one application, configured once, for every brand;
 *   • one account per brand, each with its own credentials;
 *   • no account's credentials reachable from another brand, or from a
 *     browser;
 *   • an application-level refusal named as such, with the one-time fix.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyMetaAuthFailure,
  isAppLevelAuthorizationFailure,
  metaAppAuthorizationError,
  META_GO_LIVE_REMEDY,
} from '@/lib/social/meta-app';
import { publicAccount, publicMetadata, withoutSecrets } from '@/lib/social/account-view';
import {
  completeConnection,
  disconnect,
  getUsableConnection,
  loadTokens,
} from '@/lib/social/connections';
import { INSTAGRAM_SETUP, setupGuide } from '@/lib/social/setup-guides';
import { mapMetaError } from '@/lib/social/instagram';
import { db } from '@/lib/db/repo';
import { isFullSendError } from '@/lib/errors';
import { createProject, setupContext, teardown, type TestContext } from './helpers';
import type { AccountInfo, TokenSet } from '@/lib/social/types';
import type { Project } from '@/lib/types';

afterEach(teardown);

/* ── Fixtures ───────────────────────────────────────────────────────────── */

function tokensFor(name: string, extra: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: `access-${name}`,
    refreshToken: `refresh-${name}`,
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    refreshExpiresAt: new Date(Date.now() + 60 * 86_400_000),
    scopes: [
      'instagram_business_basic',
      'instagram_business_content_publish',
      'instagram_business_manage_insights',
    ],
    ...extra,
  };
}

function accountFor(name: string, extra: Partial<AccountInfo> = {}): AccountInfo {
  return {
    externalId: `ig-${name}`,
    username: name,
    displayName: name,
    avatarUrl: null,
    followers: 100,
    metadata: { account_type: 'BUSINESS', login_mode: 'instagram_login' },
    ...extra,
  };
}

async function connect(
  ctx: TestContext,
  project: Project,
  name: string,
  extra: Partial<AccountInfo> = {},
) {
  return completeConnection(
    ctx.scope,
    project,
    'instagram',
    tokensFor(name),
    accountFor(name, extra),
  );
}

/* ── One application, several accounts ──────────────────────────────────── */

describe('one Meta application, many Instagram accounts', () => {
  it('connects a second brand without touching the first', async () => {
    const ctx = await setupContext();
    const fullsend = await createProject(ctx.scope, ctx.user.id, { name: 'FullSend' });
    const afterIdo = await createProject(ctx.scope, ctx.user.id, { name: 'AfterIDo' });

    const first = await connect(ctx, fullsend, 'fullsend_marketing_bot');
    const second = await connect(ctx, afterIdo, 'afteridobot');

    expect(first.id).not.toBe(second.id);
    expect(first.external_id).not.toBe(second.external_id);
    expect(first.project_id).toBe(fullsend.id);
    expect(second.project_id).toBe(afterIdo.id);

    // The existing account is untouched by the new one — the acceptance test
    // that matters most, because it is the account already publishing.
    const reread = await db().get(ctx.scope, 'social_accounts', first.id);
    expect(reread?.username).toBe('fullsend_marketing_bot');
    expect(reread?.status).toBe('connected');
  });

  it('connects a third the same way, with no extra application setup', async () => {
    const ctx = await setupContext();
    const projects = await Promise.all([
      createProject(ctx.scope, ctx.user.id, { name: 'FullSend' }),
      createProject(ctx.scope, ctx.user.id, { name: 'AfterIDo' }),
      createProject(ctx.scope, ctx.user.id, { name: 'PlayPal' }),
    ]);

    const accounts = [];
    for (const [i, project] of projects.entries()) {
      accounts.push(await connect(ctx, project, `brand_${i}`));
    }

    expect(new Set(accounts.map((a) => a.id)).size).toBe(3);
    expect(new Set(accounts.map((a) => a.project_id)).size).toBe(3);
  });

  it('gives every account its own credentials', async () => {
    const ctx = await setupContext();
    const a = await createProject(ctx.scope, ctx.user.id, { name: 'A' });
    const b = await createProject(ctx.scope, ctx.user.id, { name: 'B' });

    const accountA = await connect(ctx, a, 'brand_a');
    const accountB = await connect(ctx, b, 'brand_b');

    const tokensA = await loadTokens(ctx.scope, accountA);
    const tokensB = await loadTokens(ctx.scope, accountB);

    expect(tokensA?.accessToken).toBe('access-brand_a');
    expect(tokensB?.accessToken).toBe('access-brand_b');
    expect(tokensA?.accessToken).not.toBe(tokensB?.accessToken);
  });

  it('does not let one account overwrite another', async () => {
    const ctx = await setupContext();
    const a = await createProject(ctx.scope, ctx.user.id, { name: 'A' });
    const b = await createProject(ctx.scope, ctx.user.id, { name: 'B' });

    const first = await connect(ctx, a, 'brand_a');
    await connect(ctx, b, 'brand_b');

    // Reconnecting B must not move A. The vault is keyed by social account,
    // and the ciphertext is bound to (project, account) — a row that drifted
    // between the two would fail to decrypt rather than decrypt to the wrong
    // brand's token.
    await connect(ctx, b, 'brand_b');

    const stillA = await loadTokens(ctx.scope, first);
    expect(stillA?.accessToken).toBe('access-brand_a');
  });

  it('refuses to attach one account to two brands at once', async () => {
    const ctx = await setupContext();
    const a = await createProject(ctx.scope, ctx.user.id, { name: 'AfterIDo' });
    const b = await createProject(ctx.scope, ctx.user.id, { name: 'FullSend' });

    await connect(ctx, a, 'shared_account');

    await expect(connect(ctx, b, 'shared_account')).rejects.toMatchObject({
      code: 'account_already_connected',
    });
  });

  it('lets a brand take over an account the other one gave up', async () => {
    const ctx = await setupContext();
    const a = await createProject(ctx.scope, ctx.user.id, { name: 'AfterIDo' });
    const b = await createProject(ctx.scope, ctx.user.id, { name: 'FullSend' });

    await connect(ctx, a, 'shared_account');
    await disconnect(ctx.scope, a, 'instagram');

    const moved = await connect(ctx, b, 'shared_account');
    expect(moved.project_id).toBe(b.id);
  });

  it('reconnecting the same brand keeps one account row', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id, { name: 'AfterIDo' });

    const first = await connect(ctx, project, 'afteridobot');
    const again = await connect(ctx, project, 'afteridobot');

    expect(again.id).toBe(first.id);
    const rows = await db().find(ctx.scope, 'social_accounts', {
      where: { project_id: project.id },
    });
    expect(rows).toHaveLength(1);
  });
});

/* ── Credentials stay on the server ─────────────────────────────────────── */

describe('credentials never reach a browser', () => {
  it('keeps a Page token out of the account row', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id, { name: 'AfterIDo' });

    const account = await connect(ctx, project, 'afteridobot', {
      metadata: {
        page_id: '123',
        page_name: 'AfterIDo',
        login_mode: 'facebook_login',
        // What the adapter used to store here, verbatim.
        page_access_token: 'EAAG-super-secret',
      },
      platformToken: 'EAAG-super-secret',
    });

    expect(JSON.stringify(account.platform_metadata)).not.toContain('EAAG-super-secret');
    expect(account.platform_metadata.page_id).toBe('123');
  });

  it('vaults the Page token where publishing can still read it', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id, { name: 'AfterIDo' });

    const account = await connect(ctx, project, 'afteridobot', {
      platformToken: 'EAAG-page-token',
    });
    const tokens = await loadTokens(ctx.scope, account);

    expect(tokens?.platformToken).toBe('EAAG-page-token');

    // And the stored form is ciphertext, not the token.
    const row = await db().findOne(ctx.scope, 'oauth_tokens', {
      where: { social_account_id: account.id },
    });
    expect(row?.platform_token_encrypted).toBeTruthy();
    expect(row?.platform_token_encrypted).not.toContain('EAAG-page-token');
  });

  it('strips anything that looks like a credential from the public view', () => {
    const cleaned = publicMetadata({
      account_type: 'BUSINESS',
      page_access_token: 'secret',
      refresh_token: 'secret',
      some_api_key: 'secret',
    });
    expect(cleaned).toEqual({ account_type: 'BUSINESS' });
  });

  it('still stores the facts a platform needs to publish', () => {
    /*
     * The allow-list guards what leaves the server, not what is kept. TikTok
     * stores the creator's privacy options and duration limits on the account
     * row; dropping them because a list was not updated would break posting
     * rather than leak anything.
     */
    const stored = withoutSecrets({
      privacy_level_options: ['PUBLIC_TO_EVERYONE'],
      max_video_post_duration_sec: 600,
      duet_disabled: false,
      page_access_token: 'EAAG-secret',
      union_id: 'u1',
    });
    expect(stored.privacy_level_options).toEqual(['PUBLIC_TO_EVERYONE']);
    expect(stored.max_video_post_duration_sec).toBe(600);
    expect(stored.union_id).toBe('u1');
    expect(stored).not.toHaveProperty('page_access_token');
  });

  it('hands the page an account with no secrets on it', async () => {
    const ctx = await setupContext();
    const project = await createProject(ctx.scope, ctx.user.id, { name: 'AfterIDo' });
    const account = await connect(ctx, project, 'afteridobot', {
      platformToken: 'EAAG-page-token',
    });

    const view = publicAccount(account);
    expect(JSON.stringify(view)).not.toContain('EAAG-page-token');
    expect(view.username).toBe('afteridobot');
    expect(view.status).toBe('connected');
  });
});

/* ── Brand association ──────────────────────────────────────────────────── */

describe('brand and account stay together', () => {
  it('resolves each project to its own account', async () => {
    const ctx = await setupContext();
    const afterIdo = await createProject(ctx.scope, ctx.user.id, { name: 'AfterIDo' });
    const fullsend = await createProject(ctx.scope, ctx.user.id, { name: 'FullSend' });

    await connect(ctx, afterIdo, 'afteridobot');
    await connect(ctx, fullsend, 'fullsend_marketing_bot');

    const a = await getUsableConnection(ctx.scope, afterIdo.id, 'instagram');
    const f = await getUsableConnection(ctx.scope, fullsend.id, 'instagram');

    expect(a.account.username).toBe('afteridobot');
    expect(a.tokens.accessToken).toBe('access-afteridobot');
    expect(f.account.username).toBe('fullsend_marketing_bot');
    expect(f.tokens.accessToken).toBe('access-fullsend_marketing_bot');
  });

  it('does not fall back to another brand when one is not connected', async () => {
    const ctx = await setupContext();
    const afterIdo = await createProject(ctx.scope, ctx.user.id, { name: 'AfterIDo' });
    const fullsend = await createProject(ctx.scope, ctx.user.id, { name: 'FullSend' });
    await connect(ctx, fullsend, 'fullsend_marketing_bot');

    await expect(getUsableConnection(ctx.scope, afterIdo.id, 'instagram')).rejects.toMatchObject({
      code: 'connection_error',
    });
  });
});

/* ── Authorization failures ─────────────────────────────────────────────── */

describe('an application-level refusal is named as one', () => {
  it('recognises the wording Meta actually uses', () => {
    for (const phrase of [
      'Insufficient developer role',
      'App not active: This app is not accessible right now',
      'The app is in development mode',
      'Invalid Scopes: instagram_business_content_publish',
    ]) {
      expect(isAppLevelAuthorizationFailure(phrase)).toBe(true);
    }
  });

  it('leaves an account-level problem alone', () => {
    expect(isAppLevelAuthorizationFailure('The user denied the request')).toBe(false);
    expect(classifyMetaAuthFailure('This is a Creator account')).toBeNull();
  });

  it('answers with the one-time fix rather than a per-account workaround', () => {
    const error = metaAppAuthorizationError('Insufficient developer role');
    expect(error.code).toBe('meta_app_not_live');
    expect(error.remedy).toBe(META_GO_LIVE_REMEDY);
    expect(error.remedy).toContain('one-time');
    expect(error.remedy).toContain('Live');
    // The trap this whole change exists to close.
    expect(error.remedy).toContain('Adding each account as a tester is a workaround');
  });

  it('routes a Graph permission error to the same place', () => {
    const mapped = mapMetaError({ message: 'Insufficient developer role', code: 200 }, 403);
    expect(mapped.code).toBe('meta_app_not_live');
  });

  it('still reports an ordinary permission problem as one', () => {
    const mapped = mapMetaError(
      { message: 'The permission instagram_business_content_publish has not been granted', code: 10 },
      403,
    );
    expect(mapped.code).toBe('connection_error');
    expect(isFullSendError(mapped)).toBe(true);
  });

  it('treats an expired token as an account problem, not an app one', () => {
    const mapped = mapMetaError({ message: 'Error validating access token', code: 190 }, 401);
    expect(mapped.code).toBe('connection_error');
    expect(mapped.remedy).toContain('Reconnect');
  });
});

/* ── The setup guide says the same thing ────────────────────────────────── */

describe('the setup guide separates the application from the account', () => {
  it('puts the developer work in the one-time list', () => {
    const titles = INSTAGRAM_SETUP.appSetup.map((s) => s.title.toLowerCase());
    expect(titles.some((t) => t.includes('meta app'))).toBe(true);
    expect(titles.some((t) => t.includes('app review'))).toBe(true);
  });

  it('does not send someone to App Review to connect an account they own', () => {
    /*
     * The step that opens the app to *other people's* accounts is the one that
     * drags in Advanced Access and Meta's Business Verification — a registered
     * business, a tax id, documents. Somebody connecting their own second brand
     * must be able to tell at a glance that none of that applies to them, or
     * they end up on a verification form for no reason.
     */
    const live = INSTAGRAM_SETUP.appSetup.find((s) => s.title.toLowerCase().includes('app review'));
    expect(live).toBeDefined();
    expect(live!.detail).toContain('Skip this while every Instagram account is one you own');
    expect(live!.detail).toContain('Business Verification');
  });

  it('asks a new account for a Business account, a tester invite and a click', () => {
    expect(INSTAGRAM_SETUP.perAccount).toHaveLength(3);
    const detail = INSTAGRAM_SETUP.perAccount.map((s) => s.detail).join(' ');
    expect(detail).toContain('Business');
    expect(detail).toContain('Connect Instagram');
    // The tester invite is the whole of it while the app is in Development
    // Mode — no App Review, and no merge step people were told to perform.
    expect(detail).toContain('Instagram tester');
    expect(detail.toLowerCase()).not.toContain('app review');
    expect(detail.toLowerCase()).toContain('no merge step');
  });

  it('explains why the second account was refused, and which track fixes it', () => {
    const caveats = INSTAGRAM_SETUP.caveats.join(' ');
    expect(caveats).toContain('Development Mode');
    expect(caveats).toContain('insufficient developer role');
    // Both tracks named, so nobody picks the heavy one by accident.
    expect(caveats).toContain('Accounts you own');
    expect(caveats).toContain('Accounts other people own');
    expect(caveats).toContain('Business Verification');
  });

  it('is the guide the accounts page reads', () => {
    expect(setupGuide('instagram')).toBe(INSTAGRAM_SETUP);
  });
});
