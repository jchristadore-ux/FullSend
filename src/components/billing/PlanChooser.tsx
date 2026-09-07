'use client';

import { useState } from 'react';

const TIERS = [
  {
    tier: 'free' as const,
    name: 'Free',
    price: '$0',
    blurb: 'See Instagram content go live from your repo.',
  },
  {
    tier: 'send' as const,
    name: 'Send',
    price: '$29',
    blurb: '60 posts / month. Hybrid autopilot for Instagram.',
  },
  {
    tier: 'full_send' as const,
    name: 'Full Send',
    price: '$79',
    blurb: 'Turn it on and walk away. Optimization included.',
    recommended: true,
  },
  {
    tier: 'agency' as const,
    name: 'Agency',
    price: '$249',
    blurb: 'Up to 10 projects. Every client running.',
  },
];

/**
 * Soft plan choice for new users when billing is on.
 * Free continues immediately; paid opens Checkout.
 */
export function PlanChooser({
  onContinueFree,
}: {
  onContinueFree: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(tier: (typeof TIERS)[number]['tier']) {
    setError(null);
    if (tier === 'free') {
      onContinueFree();
      return;
    }
    setBusy(tier);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.remedy ?? json.message ?? 'Checkout failed');
      window.location.assign(json.url as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  return (
    <div className="panel p-6">
      <span className="label">Choose a plan</span>
      <h2 className="mt-2 font-display text-2xl font-extrabold tracking-crush text-mist">
        Start free, or Full Send Instagram from day one.
      </h2>
      <p className="mt-2 text-sm text-dim">
        Honest Instagram-first marketing from your repo. Upgrade anytime from Billing.
      </p>
      <div className="mt-6 grid gap-px bg-edge sm:grid-cols-2">
        {TIERS.map((t) => (
          <button
            key={t.tier}
            type="button"
            disabled={busy !== null}
            onClick={() => void choose(t.tier)}
            className={[
              'flex flex-col items-start p-4 text-left transition-colors',
              t.recommended ? 'bg-orange/10 ring-1 ring-inset ring-orange' : 'bg-charcoal hover:bg-charcoal-raised',
            ].join(' ')}
          >
            <span className="font-display text-sm font-extrabold text-mist">{t.name}</span>
            <span className="mt-1 font-display text-2xl font-extrabold text-mist">
              {t.price}
              <span className="font-sans text-xs font-medium text-dimmer">/mo</span>
            </span>
            <span className="mt-2 text-xs text-dim">{t.blurb}</span>
            <span className="mt-3 font-mono text-[10px] font-bold tracking-widest text-orange">
              {busy === t.tier ? 'OPENING…' : t.tier === 'free' ? 'CONTINUE FREE →' : 'UPGRADE →'}
            </span>
          </button>
        ))}
      </div>
      {error && <p className="mt-3 font-mono text-[11px] text-fail">{error}</p>}
    </div>
  );
}
