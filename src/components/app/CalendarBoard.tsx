'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { STATUS_STYLE } from './status';
import {
  describeGenerationOutcome,
  type GenerationJob,
} from '@/lib/jobs/generation-outcome';

export interface CalendarItem {
  id: string;
  contentId: string;
  scheduledFor: string;
  status: string;
  platform: string;
  format: string;
  hook: string;
  lastError: string | null;
  attempts: number;
  preview: string | null;
}

/**
 * The calendar, grouped by day. Every entry shows its real status — including
 * failures with the reason, so nothing is hidden behind a neutral chip.
 */
export function CalendarBoard({
  projectId,
  timezone,
  days,
  windows,
  entries,
}: {
  projectId: string;
  timezone: string;
  days: number;
  windows: number[];
  entries: CalendarItem[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const byDay = new Map<string, CalendarItem[]>();
  for (const e of entries) {
    const key = e.scheduledFor.slice(0, 10);
    byDay.set(key, [...(byDay.get(key) ?? []), e]);
  }

  async function generate() {
    setGenerating(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.remedy ?? json.message);

      // Nudge the queue so the founder sees the result now rather than at the
      // next cron tick. Twice: generating content enqueues the scheduling that
      // follows it, and one drain leaves that second job sitting there.
      await fetch(`/api/projects/${projectId}/tick`, { method: 'POST' });
      await fetch(`/api/projects/${projectId}/tick`, { method: 'POST' });

      setMessage(await outcomeOf(projectId, json.jobId, days));
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function unschedule(id: string) {
    setBusy(id);
    try {
      await fetch(`/api/projects/${projectId}/calendar`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduledPostId: id, action: 'unschedule' }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {windows.map((w) => (
          <Link
            key={w}
            href={`/app/calendar?days=${w}`}
            className={[
              'border px-3 py-1.5 font-mono text-xs transition-colors',
              w === days
                ? 'border-orange bg-orange/10 text-orange'
                : 'border-edge text-dim hover:border-dim hover:text-mist',
            ].join(' ')}
          >
            {w} days
          </Link>
        ))}
        <button onClick={generate} disabled={generating} className="btn-send ml-auto !px-4 !py-2 text-xs">
          {generating ? 'GENERATING…' : `GENERATE ${days} DAYS`}
        </button>
      </div>

      {message && <p className="mt-3 font-mono text-xs text-orange">{message}</p>}

      {entries.length === 0 ? (
        <div className="panel mt-6 p-10 text-center">
          <p className="font-display text-xl font-extrabold tracking-tight text-mist">
            Nothing scheduled yet.
          </p>
          <p className="mt-2 text-sm text-dim">
            Generate a calendar and FullSend fills it with real posts.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-5">
          {[...byDay.entries()].map(([day, items]) => (
            <section key={day}>
              <h2 className="label mb-2">
                {new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'short',
                  day: 'numeric',
                  timeZone: 'UTC',
                })}
                <span className="ml-2 text-orange">{items.length}</span>
              </h2>

              <ul className="space-y-px bg-edge">
                {items.map((item) => {
                  const style = STATUS_STYLE[item.status] ?? STATUS_STYLE.draft;
                  return (
                    <li key={item.id} className="flex items-center gap-3 bg-charcoal p-3">
                      {item.preview ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.preview}
                          alt=""
                          className="h-14 w-11 shrink-0 rounded-sm border border-edge object-cover"
                        />
                      ) : (
                        <span className="h-14 w-11 shrink-0 rounded-sm border border-edge bg-void" />
                      )}

                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/app/content/${item.contentId}`}
                          className="block truncate text-sm font-semibold text-mist hover:text-orange"
                        >
                          {item.hook}
                        </Link>
                        <p className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[10px] text-dimmer">
                          <span>
                            {new Date(item.scheduledFor).toLocaleTimeString('en-US', {
                              hour: 'numeric',
                              minute: '2-digit',
                              timeZone: safeZone(timezone),
                            })}
                          </span>
                          <span className="uppercase">{item.platform}</span>
                          <span className="uppercase">{item.format}</span>
                        </p>
                        {item.lastError && (
                          <p className="mt-1 text-[11px] text-fail">
                            {item.lastError}
                            {item.attempts > 0 && ` (attempt ${item.attempts})`}
                          </p>
                        )}
                      </div>

                      <span
                        className={`shrink-0 border px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${style}`}
                      >
                        {item.status.replace('_', ' ')}
                      </span>

                      {item.status !== 'published' && (
                        <button
                          onClick={() => unschedule(item.id)}
                          disabled={busy === item.id}
                          className="shrink-0 font-mono text-xs text-dimmer transition-colors hover:text-fail"
                          aria-label="Unschedule"
                        >
                          ✕
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function safeZone(tz: string): string | undefined {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** Reads the job back so the button can say what the run actually did. */
async function outcomeOf(
  projectId: string,
  jobId: string | undefined,
  days: number,
): Promise<string> {
  const pending = `Generating a ${days}-day calendar — refresh in a moment.`;
  if (!jobId) return pending;
  try {
    const res = await fetch(`/api/projects/${projectId}/jobs/${jobId}`, { cache: 'no-store' });
    if (!res.ok) return pending;
    return describeGenerationOutcome((await res.json()) as GenerationJob, days);
  } catch {
    return pending;
  }
}
