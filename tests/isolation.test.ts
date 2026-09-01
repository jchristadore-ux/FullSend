/**
 * Tenant isolation and the background job system.
 *
 * The isolation tests deliberately attack the store the way a bug or a hostile
 * client would: guessing ids, passing another tenant's id in a filter, and
 * writing rows that claim to belong elsewhere.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, createUser, setupContext, teardown, type TestContext } from './helpers';
import { db, enqueue } from '@/lib/db/repo';
import { systemScope, userScope, TENANT_KEY, type TableName } from '@/lib/db';
import { newId, nowIso } from '@/lib/ids';
import {
  backoffSeconds,
  CRON_MAX_HEAVY_PER_PASS,
  cronSecretValid,
  drainQueue,
  HEAVY_JOB_RESERVE_MS,
  HEAVY_JOBS,
  queueStats,
  runJob,
} from '@/lib/jobs/runner';
import { check, LIMITS, remaining, resetLimits } from '@/lib/rate-limit';
import { extractJson } from '@/lib/ai/client';
import { FULLSEND_VOICE } from '@/lib/brand/fullsend-brand';
import { runQualityControl } from '@/lib/qc/check';
import { signInRemedy } from '@/lib/auth/signin-errors';
import { isSchemaMissing } from '@/lib/db/supabase-store';
import { failureRemedy } from '@/lib/jobs/failure-remedy';
import { describeGenerationOutcome } from '@/lib/jobs/generation-outcome';
import { isBillingFailure, providerMessage } from '@/lib/ai/provider-errors';
import { fullsendLockupSvg, fullsendIconSvg, fullsendFaviconSvg, fullsendAppIconSvg } from '@/lib/brand/logo';
import type { Project, User } from '@/lib/types';

describe('tenant isolation', () => {
  let ctx: TestContext;
  let owner: User;
  let ownerProject: Project;
  let intruder: User;
  let intruderProject: Project;

  beforeEach(async () => {
    ctx = await setupContext('owner@example.com');
    owner = ctx.user;
    ownerProject = await createProject(ctx.scope, owner.id, { name: 'Owner App' });

    intruder = await createUser('intruder@example.com');
    intruderProject = await createProject(userScope(intruder.id), intruder.id, {
      name: 'Intruder App',
    });

    // Give the owner a row in every project-keyed table.
    await db().insert(ctx.scope, 'content_items', {
      id: newId(),
      project_id: ownerProject.id,
      campaign_id: null,
      pillar_id: null,
      persona_id: null,
      platform: 'instagram',
      format: 'static',
      hook: 'Owner secret hook',
      script: null,
      caption: 'Owner secret caption',
      cta: '',
      hashtags: [],
      video_plan: null,
      slides: null,
      creative_asset_ids: [],
      status: 'draft',
      dedup_hash: newId(),
      qc: null,
      scheduled_for: null,
      published_at: null,
      origin: 'manual',
      ai_cost_usd: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  });

  afterEach(() => teardown());

  it('every table declares how it is tenant-scoped', () => {
    const tables: TableName[] = [
      'projects',
      'content_items',
      'social_accounts',
      'oauth_tokens',
      'published_posts',
      'analytics',
      'notifications',
      'subscriptions',
    ];
    for (const t of tables) {
      expect(TENANT_KEY[t]).toBeDefined();
      expect(TENANT_KEY[t]).not.toBe(undefined);
    }
    // The two most sensitive tables are project-scoped, not global.
    expect(TENANT_KEY.oauth_tokens).toBe('project_id');
    expect(TENANT_KEY.content_items).toBe('project_id');
  });

  it('a list query never returns another tenant’s rows', async () => {
    const rows = await db().find(userScope(intruder.id), 'content_items', {});
    expect(rows).toHaveLength(0);
  });

  it('passing another tenant’s project id in a filter returns nothing', async () => {
    const rows = await db().find(userScope(intruder.id), 'content_items', {
      where: { project_id: ownerProject.id },
    });
    expect(rows).toHaveLength(0);
  });

  it('fetching another tenant’s row by its real id is refused', async () => {
    const owned = await db().find(ctx.scope, 'content_items', {});
    const id = owned[0].id;

    let refused = false;
    let result: unknown = undefined;
    try {
      result = await db().get(userScope(intruder.id), 'content_items', id);
    } catch {
      refused = true;
    }
    expect(refused || result === null).toBe(true);
  });

  it('updating another tenant’s row is refused', async () => {
    const owned = await db().find(ctx.scope, 'content_items', {});
    await expect(
      db().update(userScope(intruder.id), 'content_items', owned[0].id, { hook: 'pwned' }),
    ).rejects.toThrow();

    const unchanged = await db().get(ctx.scope, 'content_items', owned[0].id);
    expect(unchanged!.hook).toBe('Owner secret hook');
  });

  it('deleting another tenant’s row is refused', async () => {
    const owned = await db().find(ctx.scope, 'content_items', {});
    await expect(
      db().remove(userScope(intruder.id), 'content_items', owned[0].id),
    ).rejects.toThrow();
    expect(await db().get(ctx.scope, 'content_items', owned[0].id)).not.toBeNull();
  });

  it('writing a row into another tenant’s project is refused', async () => {
    await expect(
      db().insert(userScope(intruder.id), 'content_items', {
        id: newId(),
        project_id: ownerProject.id,
        campaign_id: null,
        pillar_id: null,
        persona_id: null,
        platform: 'instagram',
        format: 'static',
        hook: 'injected',
        script: null,
        caption: 'injected',
        cta: '',
        hashtags: [],
        video_plan: null,
        slides: null,
        creative_asset_ids: [],
        status: 'draft',
        dedup_hash: newId(),
        qc: null,
        scheduled_for: null,
        published_at: null,
        origin: 'manual',
        ai_cost_usd: 0,
        created_at: nowIso(),
        updated_at: nowIso(),
      }),
    ).rejects.toThrow();
  });

  it('a user can only see themselves in the users table', async () => {
    const seen = await db().find(userScope(intruder.id), 'users', {});
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe(intruder.id);
  });

  it('counts are scoped too', async () => {
    expect(await db().count(userScope(intruder.id), 'content_items', {})).toBe(0);
    expect(await db().count(ctx.scope, 'content_items', {})).toBe(1);
  });

  it('the system scope crosses tenants, as background jobs need to', async () => {
    const all = await db().find(systemScope('test'), 'content_items', {});
    expect(all.length).toBe(1);
    const projects = await db().find(systemScope('test'), 'projects', {});
    expect(projects.length).toBe(2);
    void intruderProject;
  });

  it('accessibleProjectIds lists only what the tenant owns', async () => {
    const ownerIds = await db().accessibleProjectIds(ctx.scope);
    const intruderIds = await db().accessibleProjectIds(userScope(intruder.id));
    expect(ownerIds).toEqual([ownerProject.id]);
    expect(intruderIds).toEqual([intruderProject.id]);
    expect(await db().accessibleProjectIds(systemScope('test'))).toBe('all');
  });
});

describe('background jobs', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
  });
  afterEach(() => teardown());

  it('claims a job exactly once even under concurrency', async () => {
    const sys = systemScope('test');
    await enqueue(sys, 'collect_analytics', { projectId: project.id }, { projectId: project.id });

    const claims = await Promise.all([
      db().claimNextJob(nowIso(), 60_000),
      db().claimNextJob(nowIso(), 60_000),
      db().claimNextJob(nowIso(), 60_000),
    ]);
    const claimed = claims.filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe('running');
    expect(claimed[0]!.attempts).toBe(1);
  });

  it('does not claim a job scheduled for the future', async () => {
    const sys = systemScope('test');
    await enqueue(
      sys,
      'collect_analytics',
      { projectId: project.id },
      { projectId: project.id, runAfter: new Date(Date.now() + 3600_000).toISOString() },
    );
    expect(await db().claimNextJob(nowIso(), 60_000)).toBeNull();
  });

  it('reclaims a job whose worker died', async () => {
    const sys = systemScope('test');
    const job = await enqueue(sys, 'collect_analytics', { projectId: project.id });
    await db().update(sys, 'jobs', job.id, {
      status: 'running',
      locked_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    });

    const reclaimed = await db().claimNextJob(nowIso(), 10 * 60_000);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.id).toBe(job.id);
    expect(reclaimed!.attempts).toBe(1);
  });

  it('requeues a failed job with backoff, then kills it', async () => {
    const sys = systemScope('test');
    // A job whose project does not exist fails deterministically.
    const job = await enqueue(sys, 'daily_autopilot', { projectId: 'does-not-exist' }, {
      maxAttempts: 2,
    });

    const first = await db().claimNextJob(nowIso(), 60_000);
    const outcome = await runJob(first!);
    expect(outcome.status).toBe('failed');

    const requeued = await db().get(sys, 'jobs', job.id);
    expect(requeued!.status).toBe('queued');
    expect(requeued!.last_error).toBeTruthy();
    expect(Date.parse(requeued!.run_after)).toBeGreaterThan(Date.now());

    // Once attempts are exhausted the job is dead, and recorded — never dropped.
    await db().update(sys, 'jobs', job.id, { attempts: 2, run_after: nowIso() });
    const second = await db().claimNextJob(nowIso(), 60_000);
    expect((await runJob(second!)).status).toBe('dead');

    const errors = await db().find(sys, 'automation_errors', {});
    expect(errors.some((e) => e.scope.startsWith('job:'))).toBe(true);
  });

  it('backs off exponentially with a cap', () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(120);
    expect(backoffSeconds(3)).toBe(240);
    expect(backoffSeconds(20)).toBe(3600);
  });

  it('drains independent jobs up to the bound it was given', async () => {
    // schedule_content only touches the database — the class of work a pass is
    // allowed to run several of.
    const sys = systemScope('test');
    for (let i = 0; i < 3; i++) {
      await enqueue(sys, 'schedule_content', { projectId: project.id }, { projectId: project.id });
    }
    const result = await drainQueue({ max: 10 });
    expect(result.processed).toBe(3);
    expect(result.stopped).toBe('empty');

    const stats = await queueStats();
    expect(stats.succeeded + stats.failed + stats.dead).toBe(3);
    expect(stats.queued).toBe(0);
  });

  it('stops after one expensive job, however many are waiting', async () => {
    // The bound that matters: thirty generations are thirty passes, never one
    // invocation that runs thirty AI calls and dies half-way through.
    const sys = systemScope('test');
    for (let i = 0; i < 3; i++) {
      await enqueue(sys, 'generate_content', { projectId: project.id }, { projectId: project.id });
    }
    const result = await drainQueue({ max: 10 });
    expect(result.processed).toBe(1);
    expect(result.stopped).toBe('heavy');
    expect((await queueStats()).queued).toBe(2);
  });

  /*
   * The cron pass is allowed more than one, and this is why it has to be.
   *
   * A post is one heavy job now, so a month of content is tens of them. At one
   * per pass, against a GitHub Actions cron that actually fires every one to
   * four hours rather than the five minutes it asks for, a calendar took most
   * of a day. The invocation has 300 seconds and was using a few of them.
   */
  it('runs the whole heavy allowance when the caller has the budget for it', async () => {
    const sys = systemScope('test');
    const waiting = CRON_MAX_HEAVY_PER_PASS + 2;
    for (let i = 0; i < waiting; i++) {
      await enqueue(sys, 'generate_content', { projectId: project.id }, { projectId: project.id });
    }
    const result = await drainQueue({
      max: 25,
      budgetMs: 200_000,
      maxHeavy: CRON_MAX_HEAVY_PER_PASS,
    });
    expect(result.processed).toBe(CRON_MAX_HEAVY_PER_PASS);
    expect(result.stopped).toBe('heavy');
    expect((await queueStats()).queued).toBe(waiting - CRON_MAX_HEAVY_PER_PASS);
  });

  /*
   * The bound and the invocation it has to fit inside, held together. A cron
   * pass reserves for the slowest job before each claim, so the worst case is
   * the last one starting just inside the budget and running the full provider
   * timeout — and that has to land well short of `maxDuration`.
   */
  it('keeps the cron heavy allowance inside the invocation it runs in', () => {
    const CRON_MAX_DURATION_MS = 300_000;
    const CRON_DRAIN_BUDGET_MS = 200_000;
    const worstCase = CRON_DRAIN_BUDGET_MS + HEAVY_JOB_RESERVE_MS;
    expect(worstCase).toBeLessThan(CRON_MAX_DURATION_MS);
    // And the allowance is worth having: more than the one-at-a-time it was.
    expect(CRON_MAX_HEAVY_PER_PASS).toBeGreaterThan(1);
  });

  /*
   * A pass that may claim a second heavy job cannot know the next claim is
   * cheap, so it must keep back enough for the longest one. Getting this wrong
   * is how an invocation is killed mid-job and leaves a claimed row stranded —
   * which the pipeline then has to describe to somebody.
   */
  it('will not start another job without room for the slowest one', async () => {
    const sys = systemScope('test');
    for (let i = 0; i < 3; i++) {
      await enqueue(sys, 'generate_content', { projectId: project.id }, { projectId: project.id });
    }
    // Comfortably more than the light-job headroom, far less than a heavy job.
    const result = await drainQueue({ max: 10, budgetMs: 20_000, maxHeavy: 4 });
    expect(result.processed).toBe(0);
    expect(result.stopped).toBe('budget');
    expect((await queueStats()).queued).toBe(3);
  });

  it('never follows a chain into a second stage in the same pass', async () => {
    // daily_autopilot is cheap and its whole job is to enqueue the expensive
    // ones. Those successors belong to the next pass.
    const sys = systemScope('test');
    await enqueue(sys, 'daily_autopilot', { projectId: project.id }, { projectId: project.id });

    const result = await drainQueue({ max: 25 });
    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);

    // The successors it queued are real, and still queued.
    const stats = await queueStats();
    expect(stats.queued).toBeGreaterThan(0);
    const queued = await db().find(sys, 'jobs', { where: { status: 'queued' } });
    expect(queued.some((j) => j.type === 'generate_content')).toBe(true);
  });

  it('honours the time budget rather than starting work it cannot finish', async () => {
    const sys = systemScope('test');
    for (let i = 0; i < 3; i++) {
      await enqueue(sys, 'schedule_content', { projectId: project.id }, { projectId: project.id });
    }
    // An invocation with no time left claims nothing at all, rather than
    // starting a job it would be killed part-way through — the exact way a
    // claimed job used to end up stranded in `running`.
    const result = await drainQueue({ max: 10, budgetMs: 0 });
    expect(result.processed).toBe(0);
    expect(result.stopped).toBe('budget');
    expect((await queueStats()).queued).toBe(3);
  });

  it('leaves a job for the next pass rather than claiming it twice', async () => {
    const sys = systemScope('test');
    await enqueue(sys, 'schedule_content', { projectId: project.id }, { projectId: project.id });

    const [a, b] = await Promise.all([drainQueue({ max: 5 }), drainQueue({ max: 5 })]);
    expect(a.processed + b.processed).toBe(1);
  });

  it('classifies every job that talks to an AI provider or a platform as expensive', () => {
    /*
     * The list is what bounds a worker pass, so a new job type that calls out
     * to somebody else's servers and is not on it would quietly reintroduce
     * the long-running invocation this whole design exists to prevent.
     */
    for (const type of [
      'analyze_repository',
      'generate_strategy',
      'generate_brand',
      'generate_content',
      'optimize',
      'collect_analytics',
      'scan_trends',
      'publish_post',
    ] as const) {
      expect(HEAVY_JOBS.has(type)).toBe(true);
    }
    // Bookkeeping only: several of these in one pass is the point.
    for (const type of ['schedule_content', 'quality_control', 'daily_autopilot'] as const) {
      expect(HEAVY_JOBS.has(type)).toBe(false);
    }
  });

  it('refuses cron requests without the shared secret', () => {
    expect(cronSecretValid(null)).toBe(false);
    expect(cronSecretValid('Bearer wrong')).toBe(false);
    expect(cronSecretValid('Bearer test-cron-secret')).toBe(true);
    expect(cronSecretValid('test-cron-secret')).toBe(true);
  });
});

describe('rate limiting', () => {
  beforeEach(() => resetLimits());

  it('allows up to the limit then refuses with a retry hint', () => {
    const rule = { limit: 3, windowMs: 60_000 };
    for (let i = 0; i < 3; i++) check('k', rule);
    expect(() => check('k', rule)).toThrow(/Too many requests/);
    expect(remaining('k', rule)).toBe(0);
  });

  it('keys are independent', () => {
    const rule = { limit: 1, windowMs: 60_000 };
    check('user-a', rule);
    expect(() => check('user-a', rule)).toThrow();
    expect(() => check('user-b', rule)).not.toThrow();
  });

  it('resets after the window', () => {
    const rule = { limit: 1, windowMs: 1000 };
    const now = Date.now();
    check('k', rule, now);
    expect(() => check('k', rule, now + 500)).toThrow();
    expect(() => check('k', rule, now + 1500)).not.toThrow();
  });

  it('defines a limit for every expensive operation', () => {
    for (const rule of Object.values(LIMITS)) {
      expect(rule.limit).toBeGreaterThan(0);
      expect(rule.windowMs).toBeGreaterThan(0);
    }
  });
});

describe('AI response parsing', () => {
  it('extracts JSON from a fenced block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts JSON surrounded by prose', () => {
    expect(extractJson('Here you go: {"a":1} — hope that helps')).toBe('{"a":1}');
  });

  it('handles nested braces and braces inside strings', () => {
    const json = '{"a":{"b":[1,2]},"c":"a } brace"}';
    expect(extractJson(`prefix ${json} suffix`)).toBe(json);
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractJson('no json here')).toBeNull();
  });
});

describe('brand consistency', () => {
  it('the house voice bans the usual AI slop', () => {
    for (const phrase of ['delve', 'game-changer', 'unlock the power of']) {
      expect(FULLSEND_VOICE.wordsToAvoid).toContain(phrase);
    }
  });

  it('quality control enforces the brand profile it is given', () => {
    const qc = runQualityControl({
      item: {
        platform: 'instagram',
        format: 'static',
        hook: 'A hook',
        caption: 'Let us delve into this game-changer.',
        cta: 'Link in bio',
        hashtags: ['#x'],
        video_plan: null,
        slides: null,
      },
      analysis: null,
      brand: {
        words_to_avoid: [...FULLSEND_VOICE.wordsToAvoid],
        words_to_use: [],
        emoji_policy: 'sparing',
      },
    });
    const flagged = qc.findings.filter((f) => f.check === 'brand_consistency');
    expect(flagged.length).toBeGreaterThanOrEqual(2);
    expect(qc.requires_human_review).toBe(true);
  });
});

describe('the FullSend mark', () => {
  it('renders every lockup as valid, self-contained SVG', () => {
    const variants = [
      fullsendLockupSvg({ tone: 'dark' }),
      fullsendLockupSvg({ tone: 'light' }),
      fullsendLockupSvg({ tone: 'mono-white' }),
      fullsendIconSvg({ tone: 'dark' }),
      fullsendIconSvg({ tone: 'dark', compact: true }),
      fullsendFaviconSvg(),
    ];
    for (const svg of variants) {
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.trim().endsWith('</svg>')).toBe(true);
      expect(svg).toContain('viewBox');
      // No fetched resources — the mark must render offline. The xmlns
      // namespace is an identifier, not a request, so it is excluded.
      expect(svg).not.toMatch(/(?:href|src)\s*=\s*["']https?:/);
      expect(svg).not.toMatch(/url\(\s*["']?https?:/);
      expect(svg).not.toContain('<image');
      expect(svg).not.toContain('@font-face');
    }
  });

  it('carries the electric orange in colour variants and drops it in monochrome', () => {
    expect(fullsendLockupSvg({ tone: 'dark' })).toContain('#FF5A1F');
    expect(fullsendLockupSvg({ tone: 'mono-black' })).not.toContain('#FF5A1F');
  });
});

describe('sign-in failures', () => {
  it('never blames the address for a Supabase project setting', () => {
    const notTheAddress = [
      'Signups not allowed for otp',
      'Email logins are disabled',
      'Error sending magic link email',
      'email rate limit exceeded',
    ];
    for (const message of notTheAddress) {
      expect(signInRemedy(message)).not.toMatch(/check the address/i);
    }
  });

  it('names the setting that actually needs changing', () => {
    expect(signInRemedy('Signups not allowed for otp')).toMatch(/allow new users to sign up/i);
    expect(signInRemedy('Error sending magic link email')).toMatch(/smtp/i);
    expect(signInRemedy('email rate limit exceeded')).toMatch(/rate-limiting/i);
    expect(signInRemedy('Redirect URL not allowed for this instance')).toMatch(/redirect urls/i);
  });

  it('does blame the address when the address is genuinely invalid', () => {
    expect(signInRemedy('Unable to validate email address: invalid format')).toMatch(
      /check the address/i,
    );
  });

  it('points at the host, not the address, when the platform answers for us', () => {
    expect(signInRemedy('The operation was aborted due to timeout')).toMatch(/smtp|did not respond/i);
    expect(signInRemedy('fetch failed')).toMatch(/could not reach supabase/i);
    expect(signInRemedy('fetch failed')).not.toMatch(/check the address/i);
  });

  it('always gives somewhere to look, even for a message it has never seen', () => {
    const remedy = signInRemedy('some entirely new failure mode');
    expect(remedy).toBeTruthy();
    expect(remedy).toMatch(/auth logs/i);
  });
});

describe('a database with no schema in it', () => {
  it('recognises how Postgres and PostgREST each report a missing table', () => {
    expect(isSchemaMissing({ code: '42P01', message: 'relation "projects" does not exist' })).toBe(true);
    expect(
      isSchemaMissing({
        code: 'PGRST205',
        message: "Could not find the table 'public.projects' in the schema cache",
      }),
    ).toBe(true);
  });

  it('does not mistake an ordinary failure for a missing schema', () => {
    expect(isSchemaMissing({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(false);
    expect(isSchemaMissing({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBe(false);
    expect(isSchemaMissing({})).toBe(false);
  });
});

describe('what a failed job tells the founder to do', () => {
  // Verbatim from a real deployment, envelope and all.
  const REAL = String.raw`Anthropic API error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}`;

  it('sends an out-of-credit account to billing, not to their repository', () => {
    const remedy = failureRemedy(REAL);
    expect(remedy).toMatch(/credit/i);
    expect(remedy).toMatch(/billing/i);
    expect(remedy).not.toMatch(/repository is public/i);
  });

  it('still points at the repository when the repository is the problem', () => {
    expect(failureRemedy('GitHub 404: could not find the repository')).toMatch(/public/i);
  });

  it('separates a rejected key from an empty balance', () => {
    expect(failureRemedy('The Anthropic API key was rejected')).toMatch(/ANTHROPIC_API_KEY/);
    expect(failureRemedy('The Anthropic API key was rejected')).not.toMatch(/credit/i);
  });

  it('names the migration when the schema is missing', () => {
    expect(failureRemedy('The `projects` table does not exist')).toMatch(/0001_fullsend_init/);
  });

  it('always gives somewhere to look for anything unrecognised', () => {
    expect(failureRemedy('something nobody has seen before')).toMatch(/admin/i);
  });
});

describe('reading a vendor API failure', () => {
  it('pulls the sentence out of the JSON envelope', () => {
    const e = {
      message: '400 {"type":"error","error":{"message":"Your credit balance is too low"}}',
      error: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } },
    };
    expect(providerMessage(e)).toBe('Your credit balance is too low');
  });

  it('falls back to the envelope, without the status code, when there is no body', () => {
    expect(providerMessage({ message: '503 Service Unavailable' })).toBe('Service Unavailable');
  });

  it('recognises a billing failure from either vendor', () => {
    expect(isBillingFailure('Your credit balance is too low')).toBe(true);
    expect(isBillingFailure('You exceeded your current quota, please check your plan')).toBe(true);
    expect(isBillingFailure('overloaded_error')).toBe(false);
  });
});

describe('the home-screen icon', () => {
  it('is full-bleed when it will be masked, rounded when it will not', () => {
    // iOS and Android both apply their own shape. Corners in the source get
    // rounded twice and leave notches, which is why maskable drops them.
    expect(fullsendAppIconSvg(180, { maskable: true })).toContain('rx="0"');
    expect(fullsendAppIconSvg(512)).toContain('rx="114"');
  });

  it('keeps the mark inside the area every mask preserves', () => {
    // Launchers guarantee only the middle 80% — 51.2 to 460.8 of a 512 box.
    // The mark is drawn from 102 at scale 3.08 over a ~96-unit symbol.
    const start = 102;
    const end = 102 + 96 * 3.08;
    expect(start).toBeGreaterThan(51.2);
    expect(end).toBeLessThan(460.8);
    expect(fullsendAppIconSvg(512, { maskable: true })).toContain('translate(102 102) scale(3.08)');
  });

  it('carries the electric orange, whatever the size', () => {
    for (const size of [180, 192, 512]) {
      expect(fullsendAppIconSvg(size)).toContain('#FF5A1F');
    }
  });
});

describe('what "Generate" reports back', () => {
  const done = (result: Record<string, unknown>) => ({ status: 'succeeded', result });

  it('says how many posts it wrote', () => {
    expect(describeGenerationOutcome(done({ generated: 18 }), 14)).toBe('Wrote 18 posts.');
    expect(describeGenerationOutcome(done({ generated: 1 }), 14)).toBe('Wrote 1 post.');
  });

  it('mentions anything quality control held back', () => {
    expect(describeGenerationOutcome(done({ generated: 18, blockedByQc: 6 }), 14)).toBe(
      'Wrote 18 posts. 6 held for your review.',
    );
  });

  it('explains a run that deliberately made nothing, rather than looking broken', () => {
    // The case that prompted this: the calendar was already full, the job
    // succeeded, and the UI said "refresh in a moment" — so the refresh showed
    // the same screen with nothing to explain it.
    const msg = describeGenerationOutcome(
      done({ generated: 0, reason: 'The calendar is already full for this window' }),
      14,
    );
    expect(msg).toContain('Nothing new to add');
    expect(msg).toContain('already full');
    expect(msg).toMatch(/longer window/i);
    expect(msg).not.toMatch(/refresh in a moment/i);
  });

  it('passes on the duplicate-check reason too', () => {
    expect(
      describeGenerationOutcome(done({ generated: 0, reason: 'Nothing new passed the duplicate check' }), 30),
    ).toContain('duplicate check');
  });

  it('surfaces a failure instead of claiming progress', () => {
    expect(
      describeGenerationOutcome({ status: 'dead', error: 'Your Anthropic account is out of credit' }, 14),
    ).toBe('Your Anthropic account is out of credit');
  });

  it('still reads as in-progress while it genuinely is', () => {
    expect(describeGenerationOutcome({ status: 'running' }, 14)).toMatch(/still working/i);
  });
});
