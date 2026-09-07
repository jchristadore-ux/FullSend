'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Paywall } from './Paywall';

type StatusPayload = {
  billingEnabled: boolean;
  tier: string;
  status: string;
  live: boolean;
  plan: { name: string; priceUsd: number; limits: {
    projects: number;
    posts_per_month: number;
    autopilot_modes: string[];
    optimization: boolean;
  } };
  usage: {
    projects: { used: number; limit: number };
    postsThisMonth: { used: number; limit: number };
  };
  catalog: Array<{
    tier: string;
    name: string;
    priceUsd: number;
    limits: {
      projects: number;
      posts_per_month: number;
      autopilot_modes: string[];
      optimization: boolean;
    };
  }>;
};

export function BillingView({ initial }: { initial: StatusPayload | null }) {
  const router = useRouter();
  const search = useSearchParams();
  const [status, setStatus] = useState<StatusPayload | null>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checkout = search.get('checkout');
  const upgrade = search.get('upgrade');

  useEffect(() => {
    if (!upgrade || !status?.billingEnabled) return;
    if (!['send', 'full_send', 'agency'].includes(upgrade)) return;
    void startCheckout(upgrade);
  }, [upgrade, status?.billingEnabled]);

  async function refresh() {
    const res = await fetch('/api/billing/status', { cache: 'no-store' });
    if (res.ok) setStatus(await res.json());
  }

  async function startCheckout(tier: string) {
    setBusy(`checkout:${tier}`);
    setError(null);
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

  async function openPortal() {
    setBusy('portal');
    setError(null);
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.remedy ?? json.message ?? 'Portal failed');
      window.location.assign(json.url as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  if (!status) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
        <p className="text-dim">Loading billing…</p>
      </div>
    );
  }

  if (!status.billingEnabled) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
        <span className="label">Billing</span>
        <h1 className="mt-2 font-display text-3xl font-extrabold tracking-crush text-mist">
          Billing is off
        </h1>
        <p className="mt-3 text-sm text-dim">
          This deployment has no Stripe key, so every account gets the full product with no limits.
          When Stripe is configured, free limits enforce and paid plans unlock through Checkout.
        </p>
        <Link href="/app/settings" className="btn-ghost mt-6 inline-flex">
          Back to settings
        </Link>
      </div>
    );
  }

  const postsPct = Math.min(
    100,
    Math.round((status.usage.postsThisMonth.used / Math.max(1, status.usage.postsThisMonth.limit)) * 100),
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
      <span className="label">Billing</span>
      <h1 className="mt-2 font-display text-3xl font-extrabold tracking-crush text-mist sm:text-4xl">
        Plan &amp; usage
      </h1>
      <p className="mt-2 text-sm text-dim">
        Instagram-first marketing from your repo. Upgrade when you are ready to send more.
      </p>

      {checkout === 'success' && (
        <div className="mt-4 border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-mist">
          Checkout complete. If your plan has not updated yet, wait a few seconds for the webhook,
          then refresh.
          <button type="button" className="ml-3 font-mono text-[11px] text-orange" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      )}
      {checkout === 'cancel' && (
        <div className="mt-4 border border-edge bg-charcoal px-4 py-3 text-sm text-dim">
          Checkout canceled. Your current plan is unchanged.
        </div>
      )}

      {!status.live && (
        <div className="mt-4">
          <Paywall
            title="Subscription inactive"
            message={`Status: ${status.status}. Paid features need an active or trialing subscription.`}
            remedy="Update payment in Manage billing, or pick a plan below."
          />
        </div>
      )}

      <section className="panel mt-6 p-5">
        <span className="label">Current plan</span>
        <p className="mt-2 font-display text-2xl font-extrabold tracking-tight text-mist">
          {status.plan.name}
          <span className="ml-2 font-sans text-sm font-medium text-dimmer">
            ${status.plan.priceUsd}/mo · {status.status}
          </span>
        </p>
        <div className="mt-5 space-y-3">
          <UsageBar
            label="Projects"
            used={status.usage.projects.used}
            limit={status.usage.projects.limit}
          />
          <UsageBar
            label="Posts this month"
            used={status.usage.postsThisMonth.used}
            limit={status.usage.postsThisMonth.limit}
            pct={postsPct}
          />
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            className="btn-ghost"
            disabled={busy === 'portal'}
            onClick={() => void openPortal()}
          >
            {busy === 'portal' ? 'Opening…' : 'Manage billing'}
          </button>
          <button type="button" className="btn-quiet text-sm" onClick={() => void refresh()}>
            Refresh status
          </button>
        </div>
      </section>

      <section className="mt-8">
        <span className="label">Upgrade</span>
        <div className="mt-3 grid gap-px bg-edge sm:grid-cols-2">
          {status.catalog
            .filter((c) => c.tier !== 'free')
            .map((c) => {
              const current = c.tier === status.tier && status.live;
              return (
                <div
                  key={c.tier}
                  className={[
                    'flex flex-col p-5',
                    c.tier === 'full_send' ? 'bg-orange/10 ring-1 ring-inset ring-orange' : 'bg-charcoal',
                  ].join(' ')}
                >
                  <h3 className="font-display text-lg font-extrabold text-mist">{c.name}</h3>
                  <p className="mt-1 font-display text-3xl font-extrabold text-mist">
                    ${c.priceUsd}
                    <span className="font-sans text-sm font-medium text-dimmer">/mo</span>
                  </p>
                  <ul className="mt-3 flex-1 space-y-1.5 text-sm text-dim">
                    <li>{c.limits.projects} project{c.limits.projects === 1 ? '' : 's'}</li>
                    <li>{c.limits.posts_per_month.toLocaleString()} posts / month</li>
                    <li>{c.limits.autopilot_modes.join(' · ')}</li>
                    {c.limits.optimization && <li>Weekly optimization</li>}
                  </ul>
                  <button
                    type="button"
                    disabled={current || busy !== null}
                    onClick={() => void startCheckout(c.tier)}
                    className={c.tier === 'full_send' ? 'btn-send mt-4 w-full' : 'btn-ghost mt-4 w-full'}
                  >
                    {current
                      ? 'Current plan'
                      : busy === `checkout:${c.tier}`
                        ? 'Opening Checkout…'
                        : 'Upgrade →'}
                  </button>
                </div>
              );
            })}
        </div>
      </section>

      {error && <p className="mt-4 font-mono text-[11px] text-fail">{error}</p>}

      <p className="mt-8 font-mono text-[11px] text-dimmer">
        Payments are handled by Stripe Checkout and the Customer Portal. FullSend never sees card numbers.
      </p>
      <button
        type="button"
        className="mt-4 font-mono text-[11px] text-dimmer hover:text-mist"
        onClick={() => router.push('/app/settings')}
      >
        ← Settings
      </button>
    </div>
  );
}

function UsageBar({
  label,
  used,
  limit,
  pct,
}: {
  label: string;
  used: number;
  limit: number;
  pct?: number;
}) {
  const width = pct ?? Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  return (
    <div>
      <div className="flex justify-between font-mono text-[11px] text-dimmer">
        <span>{label}</span>
        <span>
          {used} / {limit === 1000 || limit >= 10_000 ? limit.toLocaleString() : limit}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden bg-edge">
        <div className="h-full bg-orange" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}
