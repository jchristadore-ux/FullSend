'use client';

import { useEffect, useState } from 'react';

/**
 * The hero visualisation: one input, everything happens.
 *
 * The chain lights up stage by stage on a loop, so the page reads as a system
 * that is actively working rather than a static diagram.
 */

const STAGES = [
  { key: 'repo', label: 'GitHub Repo', detail: 'github.com/you/your-app', kind: 'input' },
  { key: 'analysis', label: 'Product Analysis', detail: '9 features · 3 personas', kind: 'work' },
  { key: 'strategy', label: 'Marketing Strategy', detail: '5 pillars · 3 campaigns', kind: 'work' },
  { key: 'accounts', label: 'Instagram + TikTok', detail: 'Connected', kind: 'work' },
  { key: 'calendar', label: 'Content Calendar', detail: '30 days · 28 posts', kind: 'work' },
  { key: 'published', label: 'Published', detail: 'Live', kind: 'output' },
] as const;

export function HeroFlow() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setActive((n) => (n + 1) % (STAGES.length + 2));
    }, 900);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="panel-raised relative overflow-hidden p-5 sm:p-7 shadow-panel">
      {/* Command-centre chrome. */}
      <div className="flex items-center justify-between border-b border-edge pb-4 mb-5">
        <div className="flex items-center gap-2.5">
          <span className="dot-live" />
          <span className="label text-live">AUTOPILOT ACTIVE</span>
        </div>
        <span className="label hidden sm:inline">THE SEND CENTER</span>
      </div>

      <ol className="space-y-0">
        {STAGES.map((stage, i) => {
          const done = i < active;
          const running = i === active;
          const idle = i > active;

          return (
            <li key={stage.key}>
              <div
                className={[
                  'flex items-center gap-3 sm:gap-4 rounded-sm px-3 py-3 sm:py-3.5 transition-all duration-300',
                  running ? 'bg-orange/10 ring-1 ring-orange/40' : '',
                  idle ? 'opacity-35' : '',
                ].join(' ')}
              >
                <span
                  className={[
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-sm font-mono text-[11px] font-bold transition-colors',
                    done
                      ? 'bg-live/20 text-live'
                      : running
                        ? 'bg-orange text-void'
                        : 'bg-charcoal text-dimmer',
                  ].join(' ')}
                >
                  {done ? '✓' : String(i + 1).padStart(2, '0')}
                </span>

                <div className="min-w-0 flex-1">
                  <div
                    className={[
                      'font-display font-extrabold tracking-tight text-sm sm:text-base leading-tight',
                      stage.kind === 'output' && done ? 'text-live' : 'text-mist',
                    ].join(' ')}
                  >
                    {stage.label}
                  </div>
                  <div className="font-mono text-[11px] text-dimmer truncate">{stage.detail}</div>
                </div>

                {running && (
                  <span className="hidden sm:block relative h-1 w-16 overflow-hidden rounded-full bg-edge">
                    <span className="absolute inset-y-0 w-1/4 bg-orange animate-scan" />
                  </span>
                )}
                {done && stage.kind === 'output' && (
                  <span className="label text-live shrink-0">LIVE</span>
                )}
              </div>

              {/* The connector between stages, which the pulse travels down. */}
              {i < STAGES.length - 1 && (
                <div className="relative ml-[26px] h-4 w-px overflow-hidden bg-edge">
                  {(done || running) && (
                    <span className="absolute inset-x-0 h-2 bg-orange animate-flow-down" />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
