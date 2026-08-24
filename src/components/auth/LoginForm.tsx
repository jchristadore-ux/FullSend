'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Sign-in. Supabase Auth when configured (magic link, no passwords stored by
 * FullSend); a local dev session otherwise so the product runs before anyone
 * has provisioned a database.
 */
export function LoginForm({
  mode,
  next,
  initialError,
}: {
  mode: 'supabase' | 'dev' | 'unavailable';
  next: string;
  initialError: string | null;
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  if (mode === 'unavailable') {
    return (
      <div>
        <p className="font-display text-sm font-bold tracking-tight text-warn">
          Authentication is not configured
        </p>
        <p className="mt-2 text-sm text-dim">
          Set <code className="font-mono text-xs text-mist">NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
          <code className="font-mono text-xs text-mist">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to
          enable sign-in.
        </p>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, next }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.remedy ?? json.message ?? 'Could not sign in');

      if (json.magicLink) {
        setSent(true);
      } else {
        router.push(json.next ?? next);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div>
        <p className="font-display text-lg font-extrabold tracking-tight text-live">
          Check your email.
        </p>
        <p className="mt-2 text-sm text-dim">
          We sent a sign-in link to <span className="text-mist">{email}</span>. It expires in an
          hour.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="email" className="label">
        Email
      </label>
      <input
        id="email"
        type="email"
        required
        autoFocus
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@yourapp.com"
        className="mt-2 w-full !py-3"
      />

      {error && <p className="mt-3 text-sm text-fail">{error}</p>}

      <button type="submit" disabled={busy || !email} className="btn-send mt-5 w-full">
        {busy ? 'SENDING…' : mode === 'supabase' ? 'EMAIL ME A LINK' : 'SIGN IN'}
      </button>

      {mode === 'dev' && (
        <p className="mt-4 font-mono text-[10px] leading-relaxed text-dimmer">
          Local development session — Supabase Auth is not configured, so FullSend is issuing a
          signed local session. This is disabled in production.
        </p>
      )}
    </form>
  );
}
