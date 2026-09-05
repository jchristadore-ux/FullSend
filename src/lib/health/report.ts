/**
 * Configuration health report (authenticated).
 * Public liveness is handled by src/app/api/health/route.ts.
 */
import { env, capabilities } from '@/lib/env';
import { isSchemaMissing } from '@/lib/db/supabase-store';
import { queueHealth, type QueueHealth } from '@/lib/jobs/runner';
import { fontHealth } from '@/lib/creative/fonts';

const REACHABILITY_TIMEOUT_MS = 6000;

type Reachability =
  | { checked: false; reason: string }
  | { checked: true; ok: boolean; status?: number; ms?: number; error?: string };

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

const checkPublishingMigration = () =>
  checkColumns('scheduled_posts', ['platform_container_id', 'publish_submitted_at']);
const checkAnalysisCommitMigration = () => checkColumns('product_analysis', ['commit_sha']);
const checkBrandIdentityMigration = () =>
  checkColumns('brand_profiles', ['text_color', 'heading_font', 'locked_fields']);
const checkGenerationStateMigration = () =>
  checkColumns('content_items', ['generation_state', 'generation_error']);

type Storage =
  | { checked: false; reason: string }
  | { checked: true; exists: boolean; public?: boolean; error?: string };

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

const set = (v: string | undefined) => Boolean(v && v.trim());
const live = (name: string): string | undefined => process.env[name];

type TikTokFile = { ok: boolean; status?: number; body?: string; note: string };

async function checkTikTokFile(): Promise<TikTokFile> {
  const url = `${env.appUrl.replace(/\/+$/, '')}/tiktok-developers-site-verification.txt`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
      cache: 'no-store',
    });
    const body = (await res.text()).trim();

    if (!res.ok) {
      return { ok: false, status: res.status, note: `${url} answered ${res.status}.` };
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

export async function buildFullHealthReport(): Promise<Record<string, unknown>> {
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

  if (schema.checked && schema.installed) {
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

  const reviewBlockers: string[] = [];
  if (!set(env.contactEmail)) {
    reviewBlockers.push(
      'FULLSEND_CONTACT_EMAIL is not set — /privacy, /terms and /data-deletion have no contact address, and both TikTok and Meta reject apps whose policies name nobody reachable.',
    );
  }

  if (!creativeRenderer.ok) {
    problems.push(
      `The creative renderer cannot draw text on this host${creativeRenderer.detail ? `: ${creativeRenderer.detail}` : ''} ` +
        'Every generated image would publish blank. Check that assets/fonts shipped with the ' +
        'deployment, or set FULLSEND_FONT_DIR to a directory containing Inter-Regular.ttf.',
    );
  }

  const tiktokVerification = await checkTikTokFile();

  let queue: QueueHealth | null = null;
  try {
    queue = await queueHealth();
  } catch {
    queue = null;
  }
  if (queue && queue.oldestQueued && queue.oldestQueued.dueInSeconds <= 0) {
    const waited = queue.oldestQueued.waitingSeconds;
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

  return {
    ok: problems.length === 0,
    appUrl: env.appUrl,
    database: env.dbDriver,
    aiProvider: env.ai.provider,
    required,
    supabase,
    schema,
    migrations: {
      durablePublishing: publishingMigration,
      analysisCommit: analysisCommitMigration,
      brandIdentity: brandIdentityMigration,
      generationState: generationStateMigration,
    },
    creativeStorage,
    creativeRenderer,
    canSelfMigrate: Boolean(env.supabase.dbUrl),
    capabilities: capabilities(),
    problems,
    reviewBlockers,
    tiktokVerification,
    queue,
  };
}
