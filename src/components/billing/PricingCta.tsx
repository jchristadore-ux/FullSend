'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useSignedIn } from '@/components/marketing/SessionLinks';

type PaidTier = 'send' | 'full_send' | 'agency';

/**
 * Landing pricing button.
 *
 * Signed in + billing on → Stripe Checkout for paid tiers, onboarding for free.
 * Otherwise → login with a next= that lands them back on billing/onboarding.
 */
export function PricingCta({
  tier,
  label,
  className,
  billingEnabled,
}: {
  tier: 'free' | PaidTier;
  label: string;
  className: string;
  billingEnabled: boolean;
}) {
  const signedIn = useSignedIn();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startCheckout() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.remedy ?? json.message ?? 'Checkout failed');
      if (!json.url) throw new Error('Checkout did not return a URL');
      window.location.assign(json.url as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (tier === 'free' || !billingEnabled) {
    const href =
      signedIn === true
        ? tier === 'free' || !billingEnabled
          ? '/onboarding'
          : '/app/billing'
        : `/login?next=${encodeURIComponent(tier === 'free' ? '/onboarding' : '/app/billing')}`;
    return (
      <Link href={href} className={className}>
        {label}
      </Link>
    );
  }

  if (signedIn !== true) {
    return (
      <Link
        href={`/login?next=${encodeURIComponent('/app/billing?upgrade=' + tier)}`}
        className={className}
      >
        {label}
      </Link>
    );
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void startCheckout()}
        className={className}
      >
        {busy ? 'Opening Checkout…' : label}
      </button>
      {error && <p className="mt-2 font-mono text-[11px] text-fail">{error}</p>}
    </div>
  );
}
