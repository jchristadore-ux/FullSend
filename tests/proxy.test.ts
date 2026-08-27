/**
 * The proxy is what keeps you signed in.
 *
 * Supabase rotates refresh tokens: refreshing spends the old one. A Server
 * Component cannot write the replacement back, and the cookie adapter has to
 * swallow that failure or every authenticated page would crash — so a refresh
 * triggered from a page throws the new tokens away while invalidating the old
 * ones. The session then dies on the very next request, silently, and the only
 * symptom is being asked to sign in again on every single page load.
 *
 * Middleware owns the response, so it is the one place the refresh can stick.
 * These tests pin that it happens, that the new cookies reach the response,
 * and that the magic-link rescue still works.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getUser = vi.fn();
/** Cookies the stubbed client asks to write, as a refresh would. */
let cookiesToWrite: { name: string; value: string; options?: Record<string, unknown> }[] = [];

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, opts: { cookies: { setAll: (c: unknown[]) => void } }) => {
    return {
      auth: {
        getUser: async () => {
          // A real refresh writes the rotated pair through this callback.
          if (cookiesToWrite.length) opts.cookies.setAll(cookiesToWrite);
          return getUser();
        },
      },
    };
  },
}));

const ORIGIN = 'https://fullsend.test';

async function loadProxy() {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  return (await import('@/proxy')).proxy;
}

describe('proxy', () => {
  beforeEach(() => {
    cookiesToWrite = [];
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  });
  afterEach(() => vi.clearAllMocks());

  it('forwards a magic-link code dropped at the root to the callback', async () => {
    const proxy = await loadProxy();
    const res = await proxy(new NextRequest(`${ORIGIN}/?code=abc123`));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/api/auth/callback');
    // The code must survive the hop or there is nothing to exchange.
    expect(location.searchParams.get('code')).toBe('abc123');
  });

  it('sends a Supabase error to the sign-in screen', async () => {
    const proxy = await loadProxy();
    const res = await proxy(new NextRequest(`${ORIGIN}/?error_description=link+expired`));

    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('link expired');
  });

  it('refreshes the session on an app route', async () => {
    const proxy = await loadProxy();
    const res = await proxy(new NextRequest(`${ORIGIN}/app/calendar`));

    // Not a redirect — the page still renders and does its own auth check.
    expect(res.status).toBe(200);
    // getUser is what actually triggers the rotation.
    expect(getUser).toHaveBeenCalledOnce();
  });

  it('carries rotated cookies out on the response', async () => {
    cookiesToWrite = [
      { name: 'sb-access-token', value: 'fresh-access', options: { path: '/' } },
      { name: 'sb-refresh-token', value: 'fresh-refresh', options: { path: '/' } },
    ];

    const proxy = await loadProxy();
    const res = await proxy(new NextRequest(`${ORIGIN}/app`));

    // This is the whole fix: without it the rotated pair is discarded and the
    // spent one is all that is left.
    expect(res.cookies.get('sb-access-token')?.value).toBe('fresh-access');
    expect(res.cookies.get('sb-refresh-token')?.value).toBe('fresh-refresh');
  });

  it('does not redirect a signed-out visitor away from the marketing page', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });

    const proxy = await loadProxy();
    const res = await proxy(new NextRequest(`${ORIGIN}/`));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('passes straight through when Supabase is not configured', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const { proxy } = await import('@/proxy');

    const res = await proxy(new NextRequest(`${ORIGIN}/app`));

    expect(res.status).toBe(200);
    expect(getUser).not.toHaveBeenCalled();
  });
});
