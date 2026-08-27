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
import { NextResponse } from 'next/server';
import { env, capabilities } from '@/lib/env';
import { isSchemaMissing } from '@/lib/db/supabase-store';

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

export async function GET(): Promise<NextResponse> {
  const [supabase, schema] = await Promise.all([reachSupabase(), checkSchema()]);

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
  const tiktokVerification = await checkTikTokFile();
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
      capabilities: capabilities(),
      problems,
      /** Anything that would fail a TikTok or Meta app review. */
      reviewBlockers,
      /** Whether TikTok's URL-ownership file is actually being served. */
      tiktokVerification,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
