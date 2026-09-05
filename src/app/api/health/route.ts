/**
 * Configuration health.
 *
 * Deployments fail in ways the app cannot show you, because the thing that
 * fails is the thing that would have shown you. Sign-in breaks and the only
 * evidence lives in a hosting dashboard behind a login. This endpoint is the
 * answer to "is it configured, and can it reach what it needs", answerable
 * from a phone.
 *
 * It reports whether each value is present and whether Supabase actually
 * responds — never a secret, never a fragment of one. Which integrations are
 * configured is already visible from the sign-in and account screens, so this
 * discloses nothing those do not.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env, capabilities } from '@/lib/env';
import { isSchemaMissing } from '@/lib/db/supabase-store';
import { cronSecretValid, queueHealth, type QueueHealth } from '@/lib/jobs/runner';
import { fontHealth } from '@/lib/creative/fonts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REACHABILITY_TIMEOUT_MS = 6000;

type Reachability =
  | { checked: false; reason: string }
  | { checked: true; ok: boolean; status?: number; ms?: number; error?: string };

/**
 * Asks Supabase Auth whether it is there, from the server that actually has to
 * reach it. A browser reaching Supabase proves nothing about whether the
 * deployed function can.
 */
async function reachSupabase(): Promise<Reachability> {
  if (!env.supabase.url) return { checked: false, reason: 'NEXT_PUBLIC_SUPABASE_URL is not set' };
  if (!env.supabase.anonKey)
    return { checked: false, reason: 'NEXT_PUBLIC_SUPABASE_ANON_KEY is not set' };

  const base = env.supabase.url.replace(/\/+$/, '');
  const started = Date.now();
  try {
    const res = await fetch(`${base}/auth/v1/health`, {
      headers: { apikey: env.supabase.anonKey },
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
      cache: 'no-store',
    });
    return { checked: true, ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (e) {
    return {
      checked: true,
      ok: false,
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

type Schema =
  | { checked: false; reason: string }
  | { checked: true; installed: boolean; error?: string };

/**
 * Asks whether the tables exist.
 *
 * Reaching Supabase and having a schema in it are different things, and the
 * gap between them is invisible until the first page that queries something —
 * which is the first page after sign-in, so the app appears to break exactly
 * when it should start working. One read of `projects` settles it.
 */
async function checkSchema(): Promise<Schema> {
  const { url, serviceRoleKey } = env.supabase;
  if (!url) return { checked: false, reason: 'NEXT_PUBLIC_SUPABASE_URL is not set' };
  if (!serviceRoleKey) return { checked: false, reason: 'SUPABASE_SERVICE_ROLE_KEY is not set' };

  const base = url.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/rest/v1/projects?select=id&limit=1`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (res.ok) return { checked: true, installed: true };

    const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
    if (isSchemaMissing(body)) return { checked: true, installed: false };
    return { checked: true, installed: false, error: body.message ?? `HTTP ${res.status}` };
  } catch (e) {
    return {
      checked: true,
      installed: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

type Migration =
  | { checked: false; reason: string }
  | { checked: true; applied: boolean; error?: string };

/**
 * Asks whether a migration's columns are actually in the database.
 *
 * A migration file in the repository is not a migration in Postgres, and the
 * gap between them is invisible until the feature that needs it runs — at
 * which point the failure describes a symptom rather than the missing column.
 * Asking Postgres for the column is the only honest way to know.
 *
 * Every migration past the initial schema gets one of these. A check that
 * covers some of them and not others is worse than none: it reads as "all
 * clear" while the unchecked one is missing.
 */
async function checkColumns(table: string, columns: string[]): Promise<Migration> {
  const { url, serviceRoleKey } = env.supabase;
  if (!url) return { checked: false, reason: 'NEXT_PUBLIC_SUPABASE_URL is not set' };
  if (!serviceRoleKey) return { checked: false, reason: 'SUPABASE_SERVICE_ROLE_KEY is not set' };

  const base = url.replace(/\/+$/, '');
  try {
    const res = await fetch(
      `${base}/rest/v1/${table}?select=${columns.join(',')}&limit=1`,
      {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
        signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
        cache: 'no-store',
      },
    );
    if (res.ok) return { checked: true, applied: true };
    const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
    return { checked: true, applied: false, error: body.message ?? `HTTP ${res.status}` };
  } catch (e) {
    return { checked: true, applied: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 0003 — without it, a publish whose response is lost cannot be recovered. */
const checkPublishingMigration = () =>
  checkColumns('scheduled_posts', ['platform_container_id', 'publish_submitted_at']);

/** 0004 — without it, the same commit is analysed again on every retry. */
const checkAnalysisCommitMigration = () => checkColumns('product_analysis', ['commit_sha']);

/** 0005 — without it, every project's creative is drawn in FullSend's colours. */
const checkBrandIdentityMigration = () =>
  checkColumns('brand_profiles', ['text_color', 'heading_font', 'locked_fields']);

/**
 * 0006 — without it, a post whose creative failed is indistinguishable from
 * one that worked, which is how a calendar fills with blank images.
 */
const checkGenerationStateMigration = () =>
  checkColumns('content_items', ['generation_state', 'generation_error']);

type Storage =
  | { checked: false; reason: string }
  | { checked: true; exists: boolean; public?: boolean; error?: string };

/**
 * Asks whether the creative bucket exists and is public.
 *
 * Meta fetches media from a public URL with no session of ours. A bucket that
 * is missing or private fails at publish time with an error from Instagram
 * about the media, which reads like a content problem and is not one.
 */
async function checkCreativeStorage(): Promise<Storage> {
  const { url, serviceRoleKey, storageBucket } = env.supabase;
  if (!url) return { checked: false, reason: 'NEXT_PUBLIC_SUPABASE_URL is not set' };
  if (!serviceRoleKey) return { checked: false, reason: 'SUPABASE_SERVICE_ROLE_KEY is not set' };

  const base = url.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/storage/v1/bucket/${encodeURIComponent(storageBucket)}`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return { checked: true, exists: false, error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { public?: boolean };
    return { checked: true, exists: true, public: Boolean(body.public) };
  } catch (e) {
    return { checked: true, exists: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Present and non-empty. The value itself never leaves the server. */
const set = (v: string | undefined) => Boolean(v && v.trim());

/*
 * Read by computed key, never as `process.env.NEXT_PUBLIC_FOO`.
 *
 * Next replaces static references to a NEXT_PUBLIC_ variable with its value at
 * build time — in the Node.js environment too, not only the browser bundle. A
 * check written that way reports what was set when the build ran, which is the
 * one answer this endpoint must never give: change a variable in the hosting
 * dashboard and it would keep insisting on the old state. A computed lookup is
 * not inlined, so it reads the live environment.
 */
const live = (name: string): string | undefined => process.env[name];

type TikTokFile = { ok: boolean; status?: number; body?: string; note: string };

/**
 * Asks for the verification file the way TikTok does.
 *
 * Anonymous, no caching, and against the public URL rather than the local
 * filesystem — a file present in the repository but not reachable over HTTP is
 * exactly the failure this needs to catch.
 */
async function checkTikTokFile(): Promise<TikTokFile> {
  const url = `${env.appUrl.replace(/\/+$/, '')}/tiktok-developers-site-verification.txt`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
      cache: 'no-store',
    });
    const body = (await res.text()).trim();

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        note: `${url} answered ${res.status}.`,
      };
    }
    if (!body.startsWith('tiktok-developers-site-verification=')) {
      return {
        ok: false,
        status: res.status,
        body,
        note: `${url} answered 200 but the body is not a TikTok signature.`,
      };
    }
    return {
      ok: true,
      status: res.status,
      body,
      note: 'Serving. If TikTok still rejects it, the signature does not match the file it issued for that property.',
    };
  } catch (e) {
    return {
      ok: false,
      note: `Could not fetch ${url}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Unauthenticated: minimal liveness only. Full diagnostics need the cron secret
  // (Authorization: Bearer … or x-cron-secret) — the detailed payload discloses
  // which integrations and migrations are missing.
  const authorized =
    cronSecretValid(req.headers.get('authorization')) ||
    cronSecretValid(req.headers.get('x-cron-secret'));
  if (!authorized) {
    return NextResponse.json(
      { ok: true, appUrl: env.appUrl, problems: [] as string[] },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const [
    supabase,
    schema,
    publishingMigration,
    analysisCommitMigration,
    brandIdentityMigration,
    generationStateMigration,
    creativeStorage,
    creativeRenderer,
  ] = await Promise.all([
    reachSupabase(),
    checkSchema(),
    checkPublishingMigration(),
    checkAnalysisCommitMigration(),
    checkBrandIdentityMigration(),
    checkGenerationStateMigration(),
    checkCreativeStorage(),
    /*
     * Can this deployment actually draw text?
     *
     * The one check that would have caught thirteen blank posts before they
     * were scheduled. Rasterising an SVG needs a font on the machine doing the
     * drawing, a serverless host has none, and every downstream check passes
     * happily on an image with nothing in it.
     */
    fontHealth(),
  ]);

  const required = {
    NEXT_PUBLIC_APP_URL: set(live('NEXT_PUBLIC_APP_URL')),
    NEXT_PUBLIC_SUPABASE_URL: set(env.supabase.url),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: set(env.supabase.anonKey),
    SUPABASE_SERVICE_ROLE_KEY: set(env.supabase.serviceRoleKey),
    FULLSEND_ENCRYPTION_KEY: set(env.encryptionKey),
    CRON_SECRET: set(env.jobs.cronSecret),
  };

  const missing = Object.entries(required)
    .filter(([, present]) => !present)
    .map(([name]) => name);

  const problems: string[] = missing.map((name) => `${name} is not set`);
  if (supabase.checked && !supabase.ok) {
    problems.push(
      supabase.error
        ? `Cannot reach Supabase from the server: ${supabase.error}`
        : `Supabase answered ${supabase.status} — check that NEXT_PUBLIC_SUPABASE_URL is the Project URL from Settings → API, and that the anon key belongs to the same project.`,
    );
  }
  if (schema.checked && !schema.installed) {
    problems.push(
      schema.error
        ? `Could not read the database schema: ${schema.error}`
        : 'The database tables do not exist. Run supabase/migrations/0001_fullsend_init.sql in the Supabase SQL Editor.',
    );
  }

  /*
   * Only meaningful once the tables exist — a database with no schema at all
   * has already been reported, and repeating it as three problems reads as
   * three separate faults.
   */
  if (schema.checked && schema.installed) {
    // How to fix a missing migration depends on whether FullSend can reach the
    // database directly. Saying "paste this into the SQL editor" to someone who
    // has a button for it is worse advice than no advice.
    const fix = env.supabase.dbUrl
      ? 'Open the Control Room at /admin and press Apply under Database schema.'
      : 'Run it in the Supabase SQL Editor, or set SUPABASE_DB_URL so FullSend can apply it itself.';

    if (publishingMigration.checked && !publishingMigration.applied) {
      problems.push(
        'The durable-publishing columns are missing (supabase/migrations/0003_durable_publishing.sql). ' +
          `${fix} Without it a publish whose response is lost cannot be recovered, and a retry ` +
          'could post the same content twice.',
      );
    }
    if (analysisCommitMigration.checked && !analysisCommitMigration.applied) {
      problems.push(
        'The analysis commit column is missing (supabase/migrations/0004_analysis_commit.sql). ' +
          `${fix} Without it FullSend cannot tell which commit it already understood, and pays ` +
          'to analyse the same one again.',
      );
    }
    if (brandIdentityMigration.checked && !brandIdentityMigration.applied) {
      problems.push(
        'The brand identity columns are missing (supabase/migrations/0005_project_brand_identity.sql). ' +
          `${fix} Without it every project's creative is drawn from the same palette instead of ` +
          'its own.',
      );
    }
    if (generationStateMigration.checked && !generationStateMigration.applied) {
      problems.push(
        'The generation state columns are missing (supabase/migrations/0006_generation_state.sql). ' +
          `${fix} Without it a post whose creative failed looks exactly like one that worked, and ` +
          'schedules itself with no image.',
      );
    }
    if (creativeStorage.checked && !creativeStorage.exists) {
      problems.push(
        `The "${env.supabase.storageBucket}" storage bucket does not exist. Run ` +
          'supabase/migrations/0002_creative_storage.sql — Instagram fetches media from a public ' +
          'URL, so nothing can be published without it.',
      );
    } else if (creativeStorage.checked && creativeStorage.exists && !creativeStorage.public) {
      problems.push(
        `The "${env.supabase.storageBucket}" bucket is not public. Instagram fetches media with no ` +
          'session of ours, so a private bucket fails every publish.',
      );
    }
  }

  /*
   * Separate from `problems` on purpose.
   *
   * A missing contact address does not stop the app running, so it must not
   * turn `ok` false — but it does stop TikTok and Meta approving the app, and
   * you find that out weeks into a review queue. Reporting it here means it is
   * checkable before submitting rather than after being rejected.
   */
  const reviewBlockers: string[] = [];
  if (!set(env.contactEmail)) {
    reviewBlockers.push(
      'FULLSEND_CONTACT_EMAIL is not set — /privacy, /terms and /data-deletion have no contact address, and both TikTok and Meta reject apps whose policies name nobody reachable.',
    );
  }

  /*
   * Fetched, not inferred.
   *
   * This used to report whether an environment variable was set, which is a
   * proxy for the thing that matters and not the thing itself. TikTok does not
   * read your configuration; it makes an anonymous HTTP request for one file
   * and reads the body. So this does exactly that, against the same public URL,
   * and reports what came back — a check that cannot pass while the fetch TikTok
   * performs would fail.
   */
  if (!creativeRenderer.ok) {
    problems.push(
      `The creative renderer cannot draw text on this host${creativeRenderer.detail ? `: ${creativeRenderer.detail}` : ''} ` +
        'Every generated image would publish blank. Check that assets/fonts shipped with the ' +
        'deployment, or set FULLSEND_FONT_DIR to a directory containing Inter-Regular.ttf.',
    );
  }

  const tiktokVerification = await checkTikTokFile();

  /*
   * Never let a diagnostic take down the thing it diagnoses: with no database
   * configured, or one that is refusing connections, this is simply unknown
   * and the rest of the report still renders.
   */
  let queue: QueueHealth | null = null;
  try {
    queue = await queueHealth();
  } catch {
    queue = null;
  }
  if (queue && queue.oldestQueued && queue.oldestQueued.dueInSeconds <= 0) {
    const waited = queue.oldestQueued.waitingSeconds;
    // Two lock timeouts is well past any healthy claim delay, so at that point
    // the queue is not slow, it is unattended.
    if (waited > 360) {
      problems.push(
        `A ${queue.oldestQueued.type} job has been due and unclaimed for ${Math.round(waited / 60)} minutes. ` +
          'Nothing is draining the queue — check that the FullSend heartbeat workflow is running and that ' +
          'FULLSEND_URL and FULLSEND_CRON_SECRET match this deployment.',
      );
    }
  }
  if (!tiktokVerification.ok) {
    reviewBlockers.push(
      `TikTok cannot verify this host: ${tiktokVerification.note} Its Terms and Privacy URLs will be rejected as unverified.`,
    );
  }

  return NextResponse.json(
    {
      ok: problems.length === 0,
      // Public by definition — it is in every OAuth redirect and media URL, and
      // a wrong value here breaks both, so seeing it is the point.
      appUrl: env.appUrl,
      database: env.dbDriver,
      aiProvider: env.ai.provider,
      required,
      supabase,
      schema,
      /** Whether each migration beyond the initial schema is actually applied. */
      migrations: {
        durablePublishing: publishingMigration,
        analysisCommit: analysisCommitMigration,
        brandIdentity: brandIdentityMigration,
        generationState: generationStateMigration,
      },
      creativeStorage,
      /** Whether text actually rasterises here, measured rather than assumed. */
      creativeRenderer,
      /** Whether FullSend can apply its own migrations, or needs a person to. */
      canSelfMigrate: Boolean(env.supabase.dbUrl),
      capabilities: capabilities(),
      problems,
      /** Anything that would fail a TikTok or Meta app review. */
      reviewBlockers,
      /** Whether TikTok's URL-ownership file is actually being served. */
      tiktokVerification,
      /**
       * Whether a worker is actually draining the queue, and what is at the
       * head of it. Counts and timings only — see `QueueHealth`.
       */
      queue,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
