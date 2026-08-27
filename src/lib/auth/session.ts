/**
 * Session resolution.
 *
 * Supabase Auth when it's configured; a signed local dev session otherwise, so
 * the product is fully usable before anyone provisions a database. The dev path
 * is refused outright in production.
 */
import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { env } from '../env';
import { unauthorized } from '../errors';
import { newId, nowIso } from '../ids';
import { signState, verifyState } from '../crypto';
import { db } from '../db/repo';
import { systemScope, userScope, type TenantScope } from '../db';
import type { User } from '../types';

const DEV_COOKIE = 'fullsend_dev_session';

export interface Session {
  user: User;
  scope: TenantScope;
}

export function supabaseConfigured(): boolean {
  return Boolean(env.supabase.url && env.supabase.anonKey);
}

/*
 * Serverless hosts kill a function that runs too long and answer with their
 * own error page, which is HTML — so a slow Supabase call does not surface as
 * a Supabase problem, it surfaces as a parse error with no cause attached.
 * Failing first, on our own terms, keeps the explanation ours. Sending a magic
 * link waits on Supabase's mailer, which is the part that stalls.
 */
const SUPABASE_TIMEOUT_MS = 8000;

const timeoutFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(SUPABASE_TIMEOUT_MS) });

/** Server-side Supabase client bound to the request's cookies. */
export async function getSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(env.supabase.url!, env.supabase.anonKey!, {
    global: { fetch: timeoutFetch },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: middleware refreshes instead.
        }
      },
    },
  });
}

export async function getSession(): Promise<Session | null> {
  if (supabaseConfigured()) {
    const supabase = await getSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const sys = systemScope('session bootstrap');
    let row = await db().get(sys, 'users', user.id);
    if (!row) {
      row = await db().insert(sys, 'users', {
        id: user.id,
        email: user.email ?? '',
        name: (user.user_metadata?.full_name as string) ?? null,
        avatar_url: (user.user_metadata?.avatar_url as string) ?? null,
        is_admin: isAdminEmail(user.email),
        created_at: nowIso(),
      });
    } else {
      row = await reconcileAdmin(sys, row);
    }
    return { user: row, scope: userScope(row.id) };
  }
  return getDevSession();
}

export function isAdminEmail(email: string | null | undefined): boolean {
  return env.admin.emails.includes((email ?? '').toLowerCase());
}

/**
 * What `users.is_admin` should become, or null to leave it alone.
 *
 * The flag used to be written once, when the row was first inserted, and never
 * looked at again. So setting FULLSEND_ADMIN_EMAILS after signing in did
 * nothing at all: the row already existed, and the Control Room stayed locked
 * for the person who owned the deployment — with no way to tell from outside
 * that the setting had been read and discarded rather than never applied.
 *
 * The list is now authoritative in both directions whenever it is set: being
 * on it grants access, coming off it takes access away, both on the next
 * request. An empty list means "not configured" and is left alone rather than
 * read as "nobody is an admin" — that reading would revoke a flag an operator
 * had deliberately set in SQL.
 *
 * Takes the list as an argument rather than reading the environment, so the
 * rule can be tested directly. This decides who reaches the Control Room, and
 * a rule that cannot be tested is a rule nobody has checked.
 */
export function nextAdminFlag(
  row: { email: string; is_admin: boolean },
  adminEmails: string[],
): boolean | null {
  if (adminEmails.length === 0) return null;
  const shouldBeAdmin = adminEmails.includes(row.email.toLowerCase());
  return shouldBeAdmin === row.is_admin ? null : shouldBeAdmin;
}

async function reconcileAdmin(scope: TenantScope, row: User): Promise<User> {
  const next = nextAdminFlag(row, [...env.admin.emails]);
  return next === null ? row : db().update(scope, 'users', row.id, { is_admin: next });
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) throw unauthorized();
  return s;
}

export async function requireAdmin(): Promise<Session> {
  const s = await requireSession();
  if (!s.user.is_admin) {
    throw unauthorized();
  }
  return s;
}

/* ── Local development session ──────────────────────────────────────────── */

/**
 * Signed cookie holding a user id. Only for local development, where Supabase
 * Auth has not been configured yet; never available in production.
 */
export function devAuthAvailable(): boolean {
  return !supabaseConfigured() && env.nodeEnv !== 'production';
}

async function getDevSession(): Promise<Session | null> {
  if (!devAuthAvailable()) return null;
  const jar = await cookies();
  const raw = jar.get(DEV_COOKIE)?.value;
  if (!raw) return null;
  try {
    const { userId } = verifyState<{ userId: string }>(raw);
    const sys = systemScope('dev session');
    const user = await db().get(sys, 'users', userId);
    if (!user) return null;
    return { user, scope: userScope(user.id) };
  } catch {
    return null;
  }
}

/** Creates (or reuses) a dev user and returns the cookie value to set. */
export async function createDevSession(email: string, name?: string): Promise<{
  user: User;
  cookieName: string;
  cookieValue: string;
  maxAge: number;
}> {
  if (!devAuthAvailable()) {
    throw unauthorized();
  }
  const sys = systemScope('dev sign-in');
  const existing = await db().findOne(sys, 'users', { where: { email } });
  const user =
    existing ??
    (await db().insert(sys, 'users', {
      id: newId(),
      email,
      name: name ?? email.split('@')[0],
      avatar_url: null,
      is_admin: env.admin.emails.length === 0 || env.admin.emails.includes(email.toLowerCase()),
      created_at: nowIso(),
    }));
  const maxAge = 60 * 60 * 24 * 30;
  return {
    user,
    cookieName: DEV_COOKIE,
    cookieValue: signState({ userId: user.id }, maxAge),
    maxAge,
  };
}

export const DEV_SESSION_COOKIE = DEV_COOKIE;
