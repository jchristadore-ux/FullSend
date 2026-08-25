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

export async function GET(): Promise<NextResponse> {
  const supabase = await reachSupabase();

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
      capabilities: capabilities(),
      problems,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
