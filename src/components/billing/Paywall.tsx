'use client';

import Link from 'next/link';

/**
 * Shown when a plan limit or inactive subscription blocks an action.
 * Matches FullSend's orange-on-void panels.
 */
export function Paywall({
  title = 'Plan limit reached',
  message,
  remedy,
}: {
  title?: string;
  message: string;
  remedy?: string | null;
}) {
  return (
    <div className="panel border-orange/40 bg-orange/5 p-5">
      <span className="label text-orange">Upgrade required</span>
      <h2 className="mt-2 font-display text-xl font-extrabold tracking-tight text-mist">
        {title}
      </h2>
      <p className="mt-2 text-sm text-dim">{message}</p>
      {remedy && <p className="mt-2 text-sm text-dim">{remedy}</p>}
      <div className="mt-4 flex flex-wrap gap-3">
        <Link href="/app/billing" className="btn-send">
          View plans →
        </Link>
        <Link href="/app/settings" className="btn-ghost">
          Settings
        </Link>
      </div>
    </div>
  );
}

/** Inline banner for soft warnings (approaching limit). */
export function PlanBanner({
  text,
  cta = 'Manage plan',
}: {
  text: string;
  cta?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border border-orange/30 bg-orange/10 px-4 py-3">
      <p className="text-sm text-mist">{text}</p>
      <Link href="/app/billing" className="font-mono text-[11px] font-bold tracking-wide text-orange hover:underline">
        {cta} →
      </Link>
    </div>
  );
}
