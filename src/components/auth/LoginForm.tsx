'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Sign-in. Supabase Auth when configured (magic link, no passwords stored by
 * FullSend); a local dev session otherwise so the product runs before anyone
 * has provisioned a database.
 */
/** What failed, and the next step — kept apart so neither hides the other. */
type SignInError = { message: string; remedy: string | null };

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
  const [error, setError] = useState<SignInError | null>(
    initialError ? { message: initialError, remedy: null } : null,
  );

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
      if (!res.ok) {
        // The message says what went wrong; the remedy says what to do about
        // it. Showing only the remedy hides the cause — and the cause is
        // usually a Supabase setting, not the address that was typed.
        setError({ message: json.message ?? 'Could not sign in', remedy: json.remedy ?? null });
        return;
      }

      if (json.magicLink) {
        setSent(true);
      } else {
        router.push(json.next ?? next);
        router.refresh();
      }
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e), remedy: null });
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

      {error && (
        <div className="mt-3">
          <p className="text-sm text-fail">{error.message}</p>
          {error.remedy && <p className="mt-1.5 text-sm text-dim">{error.remedy}</p>}
        </div>
      )}

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
