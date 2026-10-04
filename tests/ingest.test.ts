/**
 * Signed ingest (The Brovisional → FullSend).
 *
 * Exercises the HTTP handlers end to end over the memory store, with the image
 * fetch and storage upload stubbed so nothing reaches the network.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { db } from '@/lib/db/repo';
import { systemScope } from '@/lib/db';
import { nowIso } from '@/lib/ids';
import { handleIngestDelete, handleIngestPost } from '@/lib/ingest/http';
import { sign, verifySignature } from '@/lib/ingest/signature';
import { buildIngestCaption } from '@/lib/ingest/caption';
import { factsSchema } from '@/lib/ingest/schema';
import type { IngestDeps } from '@/lib/ingest/service';
import { publishScheduledPost } from '@/lib/publish/publish';
import { connectPlatform, createProject, setupContext, teardown, type TestContext } from './helpers';
import type { Project } from '@/lib/types';

const SECRET = 'test-ingest-secret-current';
const PREVIOUS = 'test-ingest-secret-previous';
const sys = systemScope('test');

let png: Buffer;
let png2: Buffer;

async function makePng(seed: number): Promise<Buffer> {
  const w = 1080;
  const h = 1350;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + seed * 31 + Math.floor(i / 977)) % 256;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

function deps(over: Partial<IngestDeps> = {}): IngestDeps & { stored: string[]; removed: string[] } {
  const stored: string[] = [];
  const removed: string[] = [];
  const images: Record<string, Buffer> = {
    'https://cdn.brovisional.test/card-1.png': png,
    'https://cdn.brovisional.test/card-2.png': png2,
  };
  return {
    stored,
    removed,
    async fetchImage(url) {
      const b = images[url];
      if (!b) throw new Error(`unexpected fetch ${url}`);
      return b;
    },
    async store(path) {
      stored.push(path);
      return `https://storage.fullsend.test/${path}`;
    },
    async removeObject(path) {
      removed.push(path);
    },
    now: () => new Date(),
    ...over,
  };
}

function payload(over: Record<string, unknown> = {}) {
  return {
    project: 'brovisional',
    event_type: 'round_result',
    idempotency_key: 'brovisional:round_result:r_123',
    image_url: 'https://cdn.brovisional.test/card-1.png',
    alt_text: 'Scorecard: Mike R. shot 78 at Pine Hollow.',
    caption_hint: 'Big day at Pine Hollow.',
    facts: {
      players: [{ display_name: 'Mike R.' }],
      course: 'Pine Hollow',
      score: 78,
      differential: 6.4,
      index: 9.8,
      delta: -0.6,
    },
    brand: { primary: '#0B6E4F', accent: '#F2C14E', logo_url: 'https://cdn.brovisional.test/logo.png' },
    group_id: 'grp_1',
    ...over,
  };
}


function marketing(day: string, half: 'am' | 'pm', over: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    project: 'brovisional',
    event_type: 'marketing',
    idempotency_key: `brovisional:marketing:${day}:${half}`,
    image_url: 'https://cdn.brovisional.test/card-1.png',
    alt_text: 'The Brovisional app showing a group handicap leaderboard.',
    caption_hint: 'Your Saturday group deserves real handicaps. Post rounds, watch the index move.',
    brand: { primary: '#0B6E4F', accent: '#F2C14E' },
    group_id: `marketing-${day}`,
    ...over,
  };
  return base;
}

function signedPost(body: unknown, opts: { secret?: string; ts?: number; raw?: string; ip?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  return new Request('https://fullsend.test/api/ingest/posts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Brovisional-Timestamp': ts,
      'X-Brovisional-Signature': sign(opts.secret ?? SECRET, ts, raw),
      'X-Forwarded-For': opts.ip ?? '203.0.113.7',
    },
    body: raw,
  });
}

function signedDelete(key: string, opts: { secret?: string; ts?: number } = {}) {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  return new Request(`https://fullsend.test/api/ingest/posts/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: {
      'X-Brovisional-Timestamp': ts,
      'X-Brovisional-Signature': sign(opts.secret ?? SECRET, ts, ''),
    },
  });
}

describe('ingest signature', () => {
  const now = 1_790_000_000;
  const body = '{"a":1}';
  const secrets = { current: SECRET, previous: PREVIOUS };

  it('accepts a valid signature over the raw body', () => {
    const r = verifySignature({ timestamp: String(now), signature: sign(SECRET, now, body), rawBody: body, secrets, nowSeconds: now });
    expect(r).toEqual({ ok: true, secret: 'current' });
  });

  it('accepts the previous secret during rotation', () => {
    const r = verifySignature({ timestamp: String(now), signature: sign(PREVIOUS, now, body), rawBody: body, secrets, nowSeconds: now });
    expect(r).toEqual({ ok: true, secret: 'previous' });
  });

  it('rejects a wrong secret and a tampered body', () => {
    const bad = verifySignature({ timestamp: String(now), signature: sign('nope', now, body), rawBody: body, secrets, nowSeconds: now });
    expect(bad).toMatchObject({ ok: false, reason: 'invalid_signature' });
    const tampered = verifySignature({ timestamp: String(now), signature: sign(SECRET, now, body), rawBody: '{"a":2}', secrets, nowSeconds: now });
    expect(tampered).toMatchObject({ ok: false, reason: 'invalid_signature' });
    // Re-serialised JSON is a different byte string and must not verify.
    const reserialised = verifySignature({ timestamp: String(now), signature: sign(SECRET, now, '{ "a": 1 }'), rawBody: body, secrets, nowSeconds: now });
    expect(reserialised.ok).toBe(false);
  });

  it('rejects timestamps outside the 300s window, both directions', () => {
    for (const skew of [301, -301]) {
      const ts = now + skew;
      const r = verifySignature({ timestamp: String(ts), signature: sign(SECRET, ts, body), rawBody: body, secrets, nowSeconds: now });
      expect(r).toMatchObject({ ok: false, reason: 'stale_timestamp' });
    }
    const edge = now - 300;
    expect(verifySignature({ timestamp: String(edge), signature: sign(SECRET, edge, body), rawBody: body, secrets, nowSeconds: now }).ok).toBe(true);
  });

  it('rejects missing and malformed headers', () => {
    expect(verifySignature({ timestamp: null, signature: null, rawBody: body, secrets, nowSeconds: now })).toMatchObject({ reason: 'missing_headers' });
    expect(verifySignature({ timestamp: 'yesterday', signature: sign(SECRET, now, body), rawBody: body, secrets, nowSeconds: now })).toMatchObject({ reason: 'malformed_timestamp' });
    expect(verifySignature({ timestamp: String(now), signature: 'md5=abc', rawBody: body, secrets, nowSeconds: now })).toMatchObject({ reason: 'malformed_signature' });
  });

  it('reports not configured when no secret is set', () => {
    expect(verifySignature({ timestamp: String(now), signature: sign(SECRET, now, body), rawBody: body, secrets: {}, nowSeconds: now })).toMatchObject({ reason: 'not_configured' });
  });
});

describe('ingest caption', () => {
  it('uses only display names and golf facts; unknown fact keys are stripped', () => {
    const facts = factsSchema.parse({
      players: [{ display_name: 'Mike R.', email: 'mike@example.com' }],
      course: 'Pine Hollow',
      score: 78,
      differential: 6.4,
      index: 9.8,
      delta: -0.6,
      home_club: 'Secret CC',
      phone: '555-0100',
    });
    expect(JSON.stringify(facts)).not.toMatch(/mike@example|Secret CC|555-0100/);
    const built = buildIngestCaption({ eventType: 'round_result', captionHint: 'Big day.', facts });
    expect(built.caption).toContain('Big day.');
    expect(built.caption).toContain('Mike R. shot 78 at Pine Hollow');
    expect(built.caption).toContain('differential 6.4');
    expect(built.caption).toContain('index 9.8 (−0.6)');
    expect(built.caption).not.toMatch(/mike@example|Secret CC|555-0100/);
  });

  it('renders a weekly leaderboard in rank order', () => {
    const facts = factsSchema.parse({
      leaderboard: [
        { rank: 2, display_name: 'Sam', index: 11.2, delta: 0.3 },
        { rank: 1, display_name: 'Jo', index: 8.1, delta: -1 },
      ],
    });
    const { caption } = buildIngestCaption({ eventType: 'weekly_leaderboard', captionHint: '', facts });
    expect(caption.indexOf('1. Jo')).toBeLessThan(caption.indexOf('2. Sam'));
    expect(caption).toContain('1. Jo — 8.1 (−1.0)');
  });

  it('builds a marketing caption from caption_hint plus a link-in-bio CTA, ignoring facts', () => {
    const facts = factsSchema.parse({ players: [{ display_name: 'Mike R.' }], course: 'Pine Hollow' });
    const built = buildIngestCaption({
      eventType: 'marketing',
      captionHint: 'Your Saturday group deserves real handicaps.',
      facts,
    });
    expect(built.caption).toContain('Your Saturday group deserves real handicaps.');
    expect(built.caption).toContain('link in bio (brovisional.vercel.app)');
    expect(built.caption).not.toContain('Mike R.');
    expect(built.caption).not.toContain('Pine Hollow');
    expect(built.hashtags).toEqual(['#golf', '#handicap', '#TheBrovisional']);
    // A hint that already says "link in bio" is not given a second CTA.
    const own = buildIngestCaption({ eventType: 'marketing', captionHint: 'Join the crew, link in bio.', facts });
    expect(own.caption.match(/link in bio/gi)).toHaveLength(1);
  });

  it('never uses a too-short first line as the hook', () => {
    const built = buildIngestCaption({ eventType: 'marketing', captionHint: '⛳\nTee times are better with a real index.', facts: factsSchema.parse({}) });
    expect(built.hook).toBe('Tee times are better with a real index.');
  });
});

describe('ingest API', () => {
  let ctx: TestContext;
  let project: Project;

  beforeAll(async () => {
    png = await makePng(1);
    png2 = await makePng(2);
  });

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id, { name: 'The Brovisional', slug: 'brovisional', autopilot_mode: 'full_send' });
    process.env.BROVISIONAL_INGEST_SECRET = SECRET;
    process.env.BROVISIONAL_INGEST_SECRET_PREVIOUS = PREVIOUS;
    process.env.BROVISIONAL_PROJECT_ID = project.id;
  });

  afterEach(() => {
    delete process.env.BROVISIONAL_INGEST_SECRET;
    delete process.env.BROVISIONAL_INGEST_SECRET_PREVIOUS;
    delete process.env.BROVISIONAL_PROJECT_ID;
    teardown();
  });

  async function items() {
    return db().find(sys, 'content_items', { where: { project_id: project.id } });
  }

  it('creates a draft awaiting approval, with the image copied into our storage', async () => {
    const d = deps();
    const res = await handleIngestPost(signedPost(payload()), d);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('draft');
    expect(body.review_url).toBe(`https://fullsend.test/app/content/${body.post_id}`);

    const [item] = await items();
    expect(item!.id).toBe(body.post_id);
    // approval_required, not draft: the autopilot QC sweep must not approve it.
    expect(item!.status).toBe('approval_required');
    expect(item!.origin).toBe('ingest');
    expect(item!.generation_state).toBe('complete');
    expect(item!.dedup_hash).toBe('ingest:brovisional:round_result:r_123');
    expect(item!.caption).toContain('Mike R. shot 78 at Pine Hollow');

    const assets = await db().find(sys, 'creative_assets', { where: { content_item_id: item!.id } });
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ source: 'upload', mime_type: 'image/jpeg', width: 1080, height: 1350, alt_text: 'Scorecard: Mike R. shot 78 at Pine Hollow.' });
    expect(assets[0]!.url).toMatch(/^https:\/\/storage\.fullsend\.test\//);
    expect(d.stored[0]).toMatch(new RegExp(`^${project.id}/ingest/`));
    expect(await db().count(sys, 'scheduled_posts', { where: { project_id: project.id } })).toBe(0);
  });

  it('accepts a request signed with the previous secret', async () => {
    const res = await handleIngestPost(signedPost(payload(), { secret: PREVIOUS }), deps());
    expect(res.status).toBe(200);
  });

  it('rejects an invalid signature with 401 and creates nothing', async () => {
    const res = await handleIngestPost(signedPost(payload(), { secret: 'wrong' }), deps());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_signature' });
    expect(await items()).toHaveLength(0);
  });

  it('rejects an expired timestamp with 401', async () => {
    const res = await handleIngestPost(signedPost(payload(), { ts: Math.floor(Date.now() / 1000) - 301 }), deps());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'stale_timestamp' });
  });

  it('returns 503 (retryable) when the secret or project mapping is missing', async () => {
    delete process.env.BROVISIONAL_INGEST_SECRET;
    delete process.env.BROVISIONAL_INGEST_SECRET_PREVIOUS;
    const r1 = await handleIngestPost(signedPost(payload()), deps());
    expect(r1.status).toBe(503);
    expect(await r1.json()).toMatchObject({ error: 'ingest_not_configured', retryable: true });

    process.env.BROVISIONAL_INGEST_SECRET = SECRET;
    delete process.env.BROVISIONAL_PROJECT_ID;
    const r2 = await handleIngestPost(signedPost(payload()), deps());
    expect(r2.status).toBe(503);
  });

  it('validates the body with 400 and details', async () => {
    const cases: Record<string, unknown>[] = [
      payload({ event_type: 'birdie' }),
      payload({ idempotency_key: 'brovisional:handicap_drop:r_1' }),
      payload({ image_url: 'http://cdn.brovisional.test/card-1.png' }),
      payload({ alt_text: '' }),
      payload({ scheduled_for: 'tomorrow' }),
      payload({ brand: { primary: 'green', accent: '#fff' } }),
      payload({ project: 'someone-else' }),
    ];
    for (const c of cases) {
      const res = await handleIngestPost(signedPost(c), deps());
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('validation_failed');
      expect(Array.isArray(body.details)).toBe(true);
    }
    const badJson = await handleIngestPost(signedPost(null, { raw: '{not json' }), deps());
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toMatchObject({ error: 'invalid_json' });
    expect(await items()).toHaveLength(0);
  });

  it('updates the same post when the idempotency key is resent', async () => {
    const d = deps();
    const first = await (await handleIngestPost(signedPost(payload()), d)).json();
    const res = await handleIngestPost(
      signedPost(payload({ caption_hint: 'Even bigger day.', image_url: 'https://cdn.brovisional.test/card-2.png' })),
      d,
    );
    expect(res.status).toBe(200);
    const second = await res.json();
    expect(second).toMatchObject({ status: 'updated', post_id: first.post_id });

    const all = await items();
    expect(all).toHaveLength(1);
    expect(all[0]!.caption).toContain('Even bigger day.');
    const assets = await db().find(sys, 'creative_assets', { where: { content_item_id: first.post_id } });
    expect(assets).toHaveLength(1);
    expect(d.removed).toHaveLength(1); // the old image is cleaned out of storage
    expect(all[0]!.creative_asset_ids).toEqual([assets[0]!.id]);
  });

  it('treats an identical resend as a no-op that keeps an approved post approved', async () => {
    const first = await (await handleIngestPost(signedPost(payload()), deps())).json();
    await db().update(sys, 'content_items', first.post_id, { status: 'approved' });
    const again = await (await handleIngestPost(signedPost(payload()), deps())).json();
    expect(again).toMatchObject({ status: 'updated', post_id: first.post_id });
    expect((await db().get(sys, 'content_items', first.post_id))!.status).toBe('approved');
  });

  it('schedules at scheduled_for when the project has auto-publish on', async () => {
    await db().update(sys, 'projects', project.id, { ingest_auto_publish: true });
    const at = new Date(Date.now() + 3 * 3600_000).toISOString();
    const body = await (await handleIngestPost(signedPost(payload({ scheduled_for: at })), deps())).json();
    expect(body.status).toBe('scheduled');
    const sp = await db().findOne(sys, 'scheduled_posts', { where: { content_item_id: body.post_id } });
    expect(sp).toBeTruthy();
    expect(Date.parse(sp!.scheduled_for)).toBe(Date.parse(at));
    expect((await db().get(sys, 'content_items', body.post_id))!.status).toBe('scheduled');
  });

  it('schedules for the next slot or now when auto-publish is on and no time is given', async () => {
    await db().update(sys, 'projects', project.id, { ingest_auto_publish: true });
    const before = Date.now();
    const body = await (await handleIngestPost(signedPost(payload()), deps())).json();
    expect(body.status).toBe('scheduled');
    const sp = await db().findOne(sys, 'scheduled_posts', { where: { content_item_id: body.post_id } });
    expect(Date.parse(sp!.scheduled_for)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(sp!.scheduled_for)).toBeLessThan(before + 8 * 86_400_000);
  });

  it('publishes through the normal pipeline with the alt text, then freezes the post', async () => {
    await connectPlatform(ctx.scope, project, 'instagram');
    await db().update(sys, 'projects', project.id, { ingest_auto_publish: true });
    const body = await (await handleIngestPost(signedPost(payload({ scheduled_for: nowIso() })), deps())).json();
    expect(body.status).toBe('scheduled');
    const sp = await db().findOne(sys, 'scheduled_posts', { where: { content_item_id: body.post_id } });
    const outcome = await publishScheduledPost(sys, sp!.id);
    expect(outcome.status).toBe('published');

    const posted = [...ctx.adapters.get('instagram')!.posts.values()];
    expect(posted).toHaveLength(1);
    expect(posted[0]!.input.altTexts).toEqual(['Scorecard: Mike R. shot 78 at Pine Hollow.']);
    expect(posted[0]!.input.mediaUrls[0]).toMatch(/^https:\/\/storage\.fullsend\.test\//);

    // Resending after publish reports published and changes nothing.
    const again = await handleIngestPost(signedPost(payload({ caption_hint: 'Changed!' })), deps());
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: 'published', post_id: body.post_id });
    expect((await db().get(sys, 'content_items', body.post_id))!.caption).not.toContain('Changed!');

    // And it cannot be withdrawn.
    const del = await handleIngestDelete(signedDelete('brovisional:round_result:r_123'), 'brovisional%3Around_result%3Ar_123', deps());
    expect(del.status).toBe(409);
    expect(await del.json()).toMatchObject({ error: 'already_published' });
  });

  it('withdraws an unpublished draft, then 404s', async () => {
    const d = deps();
    const body = await (await handleIngestPost(signedPost(payload()), d)).json();
    const key = 'brovisional:round_result:r_123';
    const res = await handleIngestDelete(signedDelete(key), key, d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'withdrawn', post_id: body.post_id });
    expect(await items()).toHaveLength(0);
    expect(await db().count(sys, 'creative_assets', { where: { project_id: project.id } })).toBe(0);
    expect(d.removed).toHaveLength(1);

    const again = await handleIngestDelete(signedDelete(key), key, d);
    expect(again.status).toBe(404);
  });

  it('withdraws a scheduled post and cancels its queued publish job', async () => {
    await db().update(sys, 'projects', project.id, { ingest_auto_publish: true });
    const body = await (await handleIngestPost(signedPost(payload()), deps())).json();
    const sp = await db().findOne(sys, 'scheduled_posts', { where: { content_item_id: body.post_id } });
    const job = await db().insert(sys, 'jobs', {
      id: crypto.randomUUID(),
      project_id: project.id,
      type: 'publish_post',
      payload: { scheduledPostId: sp!.id, projectId: project.id, idempotencyKey: sp!.id },
      status: 'queued',
      attempts: 0,
      max_attempts: 5,
      run_after: nowIso(),
      locked_at: null,
      last_error: null,
      result: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    const key = 'brovisional:round_result:r_123';
    const res = await handleIngestDelete(signedDelete(key), key, deps());
    expect(res.status).toBe(200);
    expect(await db().get(sys, 'scheduled_posts', sp!.id)).toBeNull();
    expect((await db().get(sys, 'jobs', job.id))!.status).toBe('succeeded');
  });

  it('refuses a DELETE with a bad signature or a malformed key', async () => {
    await handleIngestPost(signedPost(payload()), deps());
    const key = 'brovisional:round_result:r_123';
    const bad = await handleIngestDelete(signedDelete(key, { secret: 'wrong' }), key, deps());
    expect(bad.status).toBe(401);
    const malformed = await handleIngestDelete(signedDelete('nope'), 'nope', deps());
    expect(malformed.status).toBe(400);
    expect(await items()).toHaveLength(1);
  });


  it('accepts a marketing post with no facts and schedules it at exactly scheduled_for', async () => {
    await db().update(sys, 'projects', project.id, { ingest_auto_publish: true });
    const at = '2030-05-04T11:30:00-04:00';
    const res = await handleIngestPost(signedPost(marketing('2030-05-04', 'am', { scheduled_for: at })), deps());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('scheduled');
    const item = await db().get(sys, 'content_items', body.post_id);
    expect(item!.dedup_hash).toBe('ingest:brovisional:marketing:2030-05-04:am');
    expect(item!.caption).toContain('link in bio');
    expect(item!.qc!.passed).toBe(true);
    const sp = await db().findOne(sys, 'scheduled_posts', { where: { content_item_id: body.post_id } });
    expect(sp!.scheduled_for).toBe('2030-05-04T15:30:00.000Z');
  });

  it('accepts facts: {} for marketing and requires caption_hint', async () => {
    const ok = await handleIngestPost(signedPost(marketing('2030-05-04', 'pm', { facts: {} })), deps());
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe('draft');

    const noHint = await handleIngestPost(signedPost(marketing('2030-05-05', 'am', { caption_hint: '' })), deps());
    expect(noHint.status).toBe(400);
    expect((await noHint.json()).details[0].path).toBe('caption_hint');

    const noImage = marketing('2030-05-05', 'am');
    delete noImage.image_url;
    expect((await handleIngestPost(signedPost(noImage), deps())).status).toBe(400);

    // Non-marketing events still need facts.
    const noFacts = payload();
    delete (noFacts as Record<string, unknown>).facts;
    const r = await handleIngestPost(signedPost(noFacts), deps());
    expect(r.status).toBe(400);
    expect((await r.json()).details[0].path).toBe('facts');

    // The prefix rule still applies.
    const wrong = await handleIngestPost(
      signedPost(marketing('2030-05-05', 'am', { idempotency_key: 'brovisional:round_result:2030-05-05:am' })),
      deps(),
    );
    expect(wrong.status).toBe(400);
  });

  it('schedules days of near-identical twice-daily promos without QC or dedup holding them', async () => {
    await db().update(sys, 'projects', project.id, { ingest_auto_publish: true });
    const statuses: string[] = [];
    for (let d = 1; d <= 4; d++) {
      const day = `2030-06-0${d}`;
      for (const [half, time] of [['am', '11:30'], ['pm', '19:30']] as const) {
        const res = await handleIngestPost(
          signedPost(marketing(day, half, { scheduled_for: `${day}T${time}:00-04:00` })),
          deps(),
        );
        statuses.push((await res.json()).status);
      }
    }
    expect(statuses).toEqual(Array(8).fill('scheduled'));
    expect(await db().count(sys, 'scheduled_posts', { where: { project_id: project.id } })).toBe(8);
  }, 90_000);

  it('withdraws a marketing post by its date/slot key', async () => {
    const body = await (await handleIngestPost(signedPost(marketing('2030-05-04', 'am')), deps())).json();
    const key = 'brovisional:marketing:2030-05-04:am';
    const res = await handleIngestDelete(signedDelete(key), encodeURIComponent(key), deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'withdrawn', post_id: body.post_id });
  });

  it('holds auto-publish to draft when the plan allowance is used up, but not for an operator', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_ingest';
    try {
      await db().update(sys, 'projects', project.id, { ingest_auto_publish: true });
      // Free plan: 10 posts/month, all already used this month.
      for (let i = 0; i < 10; i++) {
        await db().insert(sys, 'published_posts', {
          id: crypto.randomUUID(),
          project_id: project.id,
          content_item_id: crypto.randomUUID(),
          scheduled_post_id: null,
          social_account_id: crypto.randomUUID(),
          platform: 'instagram',
          external_id: `ext-${i}`,
          permalink: null,
          published_at: nowIso(),
          platform_response: {},
        });
      }
      const at = '2030-05-04T11:30:00-04:00';
      const held = await (await handleIngestPost(signedPost(marketing('2030-05-04', 'am', { scheduled_for: at })), deps())).json();
      expect(held.status).toBe('draft');

      // JD is in FULLSEND_ADMIN_EMAILS → operator, uncapped.
      process.env.FULLSEND_ADMIN_EMAILS = ctx.user.email;
      const ok = await (await handleIngestPost(signedPost(marketing('2030-05-04', 'pm', { scheduled_for: at })), deps())).json();
      expect(ok.status).toBe('scheduled');
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.FULLSEND_ADMIN_EMAILS;
    }
  });

  it('rate-limits unauthenticated floods with 429', async () => {
    let last = 0;
    for (let i = 0; i < 61; i++) {
      last = (await handleIngestPost(signedPost(payload(), { secret: 'wrong', ip: '198.51.100.9' }), deps())).status;
    }
    expect(last).toBe(429);
  });
});
