'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { STATUS_LABEL, STATUS_STYLE } from './status';

export interface ContentCard {
  id: string;
  hook: string;
  caption: string;
  cta: string;
  hashtags: string[];
  platform: string;
  format: string;
  status: string;
  scheduledFor: string | null;
  origin: string;
  qcPassed: boolean;
  qcFindings: string[];
  videoStatus: string | null;
  videoSeconds: number | null;
  slides: number;
  generationState: string;
  generationError: string | null;
  previews: string[];
}

export function ContentGrid({
  items,
  counts,
  total,
  activeFilter,
  statuses,
}: {
  items: ContentCard[];
  counts: Record<string, number>;
  total: number;
  activeFilter: string | null;
  statuses: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function approve(id: string, publishNow: boolean) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/content/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publishNow }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.remedy ?? json.message ?? 'Could not approve');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="mt-5 flex flex-wrap gap-2">
        <Link
          href="/app/content"
          className={chip(!activeFilter)}
        >
          All <span className="ml-1 opacity-60">{total}</span>
        </Link>
        {statuses
          .filter((s) => counts[s])
          .map((s) => (
            <Link key={s} href={`/app/content?status=${s}`} className={chip(activeFilter === s)}>
              {STATUS_LABEL[s] ?? s} <span className="ml-1 opacity-60">{counts[s]}</span>
            </Link>
          ))}
      </div>

      {error && <p className="mt-3 text-sm text-fail">{error}</p>}

      {items.length === 0 ? (
        <div className="panel mt-6 p-10 text-center">
          <p className="font-display text-xl font-extrabold tracking-tight text-mist">
            Nothing here yet.
          </p>
          <p className="mt-2 text-sm text-dim">
            Generate a calendar and FullSend fills this with real posts.
          </p>
          <Link href="/app/calendar" className="btn-send mt-5 !px-4 !py-2 text-xs">
            OPEN THE CALENDAR
          </Link>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <article key={item.id} className="panel flex flex-col overflow-hidden">
              {item.previews[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.previews[0]}
                  alt=""
                  className="aspect-[4/5] w-full border-b border-edge object-cover"
                />
              ) : (
                /*
                 * No visual, said out loud.
                 *
                 * This card used to render the copy with nothing above it,
                 * which reads as a design choice rather than a failure — and
                 * that is exactly how a run of posts with no creative at all
                 * went unnoticed. A post that is missing its picture now says
                 * so, in the space the picture would have occupied.
                 */
                <div className="flex aspect-[4/5] w-full flex-col items-start justify-center gap-2 border-b border-edge bg-fail/5 px-4">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-fail">
                    {item.generationState === 'failed' ? 'Creative failed' : 'No creative yet'}
                  </p>
                  <p className="line-clamp-4 text-[11px] leading-snug text-dim">
                    {item.generationError ??
                      'This post has copy but no image. FullSend will not publish it until one exists.'}
                  </p>
                </div>
              )}

              <div className="flex flex-1 flex-col p-4">
                <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-dimmer">
                  <span>{item.platform}</span>
                  <span>·</span>
                  <span>{item.format}</span>
                  {item.slides > 0 && <span>· {item.slides} slides</span>}
                  {item.videoSeconds && <span>· {item.videoSeconds}s</span>}
                </div>

                <Link
                  href={`/app/content/${item.id}`}
                  className="mt-2 font-display text-base font-extrabold leading-snug tracking-tight text-mist hover:text-orange"
                >
                  {item.hook}
                </Link>

                <p className="mt-2 line-clamp-3 flex-1 text-sm leading-relaxed text-dim">
                  {item.caption}
                </p>

                {item.hashtags.length > 0 && (
                  <p className="mt-2 line-clamp-1 font-mono text-[10px] text-dimmer">
                    {item.hashtags.join(' ')}
                  </p>
                )}

                {item.videoStatus === 'package_only' && (
                  <p className="mt-2 font-mono text-[10px] text-warn">
                    Production package — no rendered video file yet
                  </p>
                )}

                {!item.qcPassed && item.qcFindings.length > 0 && (
                  <div className="mt-3 border-l-2 border-fail bg-fail/5 px-2.5 py-2">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-fail">
                      Held by quality control
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {item.qcFindings.slice(0, 2).map((f, i) => (
                        <li key={i} className="text-[11px] leading-snug text-dim">
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="mt-4 flex items-center justify-between gap-2 border-t border-edge pt-3">
                  <span
                    className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${
                      STATUS_STYLE[item.status] ?? STATUS_STYLE.draft
                    }`}
                  >
                    {item.status.replace('_', ' ')}
                  </span>

                  {(item.status === 'approval_required' || item.status === 'review_required') && (
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => approve(item.id, false)}
                        disabled={busy === item.id}
                        className="btn-send !px-3 !py-1.5 text-[10px]"
                      >
                        {busy === item.id ? '…' : 'APPROVE'}
                      </button>
                      <Link
                        href={`/app/content/${item.id}`}
                        className="btn-ghost !px-3 !py-1.5 text-[10px]"
                      >
                        EDIT
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

function chip(active: boolean): string {
  return [
    'border px-3 py-1.5 font-mono text-xs transition-colors',
    active
      ? 'border-orange bg-orange/10 text-orange'
      : 'border-edge text-dim hover:border-dim hover:text-mist',
  ].join(' ');
}
