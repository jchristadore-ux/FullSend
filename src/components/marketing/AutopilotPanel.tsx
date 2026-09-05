'use client';

import { useEffect, useState } from 'react';

/**
 * The autopilot status panel from the landing page. Numbers tick up on mount so
 * the panel reads as a live readout rather than a screenshot.
 */

function rowsFor(platformsLabel: string) {
  return [
    { label: 'Content queued', value: '28 posts' },
    { label: 'Platforms', value: platformsLabel },
    { label: 'Next post', value: 'Tomorrow — 9:00 AM' },
    { label: 'Performance', value: '+34% reach this week', tone: 'live' as const },
    { label: 'AI optimization', value: 'ACTIVE', tone: 'live' as const },
  ];
}

export function AutopilotPanel({
  platformsLabel = 'Instagram (TikTok when connected)',
}: {
  platformsLabel?: string;
}) {
  const ROWS = rowsFor(platformsLabel);
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setRevealed((n) => (n >= ROWS.length ? n : n + 1));
    }, 260);
    return () => clearInterval(id);
  }, [ROWS.length]);

  return (
    <div className="panel-raised overflow-hidden shadow-panel">
      <div className="flex items-center gap-2.5 border-b border-edge bg-charcoal px-6 py-4">
        <span className="dot-live" />
        <span className="font-display text-sm font-extrabold tracking-tight text-mist">
          FULLSEND AUTOPILOT
        </span>
      </div>

      <div className="px-6 py-6">
        <div className="label">Marketing Machine Status</div>
        <div className="mt-1.5 flex items-baseline gap-3">
          <span className="stat text-4xl text-live sm:text-5xl">ACTIVE</span>
        </div>

        <dl className="mt-7 space-y-0">
          {ROWS.map((row, i) => (
            <div
              key={row.label}
              className={[
                'flex items-center justify-between gap-4 border-t border-edge py-3.5 transition-opacity duration-500',
                i < revealed ? 'opacity-100' : 'opacity-0',
              ].join(' ')}
            >
              <dt className="label">{row.label}</dt>
              <dd
                className={[
                  'font-display text-sm font-bold tracking-tight tabular-nums sm:text-base',
                  row.tone === 'live' ? 'text-live' : 'text-mist',
                ].join(' ')}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
