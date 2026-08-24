'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { STATUS_STYLE } from './status';
import type { ContentItem, PublishedPost, ScheduledPost } from '@/lib/types';

interface CreativePreview {
  id: string;
  kind: string;
  source: string;
  width: number;
  height: number;
  alt: string;
  src: string | null;
}

/**
 * One post, in full: creative, copy, the video production package, and the
 * quality-control report. Editing re-runs QC, so a human edit goes through the
 * same gate the machine does.
 */
export function ContentDetail({
  item,
  creative,
  scheduled,
  published,
  context,
}: {
  item: ContentItem;
  creative: CreativePreview[];
  scheduled: ScheduledPost | null;
  published: PublishedPost | null;
  context: {
    campaign: string | null;
    pillar: string | null;
    persona: string | null;
    timezone: string;
  };
}) {
  const router = useRouter();
  const [hook, setHook] = useState(item.hook);
  const [caption, setCaption] = useState(item.caption);
  const [cta, setCta] = useState(item.cta);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const locked = item.status === 'published';

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/content/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hook, caption, cta }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.remedy ?? json.message ?? 'Could not save');
      setNote(
        json.qc?.passed
          ? 'Saved and re-checked — passes quality control.'
          : 'Saved, but quality control now holds this post for review.',
      );
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function approve(publishNow: boolean) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/content/${item.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publishNow, override: !item.qc?.passed }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.remedy ?? json.message ?? 'Could not approve');
      setNote(
        json.published
          ? json.published.status === 'published'
            ? 'Published.'
            : `Not published: ${json.published.error ?? 'held'}`
          : 'Approved and scheduled.',
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const blocks = item.qc?.findings.filter((f) => f.severity === 'block') ?? [];
  const warns = item.qc?.findings.filter((f) => f.severity === 'warn') ?? [];

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-dimmer">
        <span className={`border px-2 py-1 ${STATUS_STYLE[item.status] ?? STATUS_STYLE.draft}`}>
          {item.status.replace('_', ' ')}
        </span>
        <span>{item.platform}</span>
        <span>·</span>
        <span>{item.format}</span>
        {context.pillar && <span>· {context.pillar}</span>}
        {context.campaign && <span>· {context.campaign}</span>}
        {item.origin !== 'initial' && <span>· from {item.origin}</span>}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,300px)_1fr]">
        {/* Creative. */}
        <div className="space-y-3">
          {creative.length === 0 ? (
            <div className="panel flex aspect-[4/5] items-center justify-center p-6 text-center">
              <p className="text-sm text-dim">No creative generated.</p>
            </div>
          ) : (
            creative.map((c) =>
              c.src ? (
                <figure key={c.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={c.src}
                    alt={c.alt}
                    className="w-full rounded-sm border border-edge"
                  />
                  <figcaption className="mt-1 font-mono text-[10px] text-dimmer">
                    {c.kind} · {c.width}×{c.height} · {c.source.replace('_', ' ')}
                  </figcaption>
                </figure>
              ) : null,
            )
          )}
        </div>

        {/* Copy. */}
        <div className="space-y-6">
          <section className="panel p-5">
            <div className="flex items-center justify-between">
              <span className="label">Copy</span>
              {!locked && (
                <button onClick={() => setEditing((v) => !v)} className="btn-quiet text-xs">
                  {editing ? 'Cancel' : 'Edit'}
                </button>
              )}
            </div>

            {editing ? (
              <div className="mt-4 space-y-4">
                <Field label="Hook">
                  <textarea
                    value={hook}
                    onChange={(e) => setHook(e.target.value)}
                    rows={2}
                    className="w-full text-sm"
                  />
                </Field>
                <Field label="Caption">
                  <textarea
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                    rows={8}
                    className="w-full text-sm"
                  />
                </Field>
                <Field label="Call to action">
                  <input value={cta} onChange={(e) => setCta(e.target.value)} className="w-full text-sm" />
                </Field>
                <button onClick={save} disabled={busy} className="btn-send !px-4 !py-2 text-xs">
                  {busy ? 'SAVING…' : 'SAVE & RE-CHECK'}
                </button>
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <div>
                  <p className="label">Hook</p>
                  <p className="mt-1 font-display text-xl font-extrabold leading-snug tracking-tight text-mist">
                    {item.hook}
                  </p>
                </div>
                <div>
                  <p className="label">Caption</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-dim">
                    {item.caption}
                  </p>
                </div>
                <div>
                  <p className="label">Call to action</p>
                  <p className="mt-1 text-sm text-mist">{item.cta}</p>
                </div>
                {item.hashtags.length > 0 && (
                  <div>
                    <p className="label">Hashtags</p>
                    <p className="mt-1 font-mono text-[11px] text-dim">{item.hashtags.join(' ')}</p>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Carousel slides. */}
          {item.slides && item.slides.length > 0 && (
            <section className="panel p-5">
              <span className="label">Slides · {item.slides.length}</span>
              <ol className="mt-3 space-y-2">
                {item.slides.map((s, i) => (
                  <li key={i} className="border-l-2 border-edge pl-3">
                    <p className="text-sm font-semibold text-mist">
                      {i + 1}. {s.headline}
                    </p>
                    <p className="text-sm text-dim">{s.body}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* Video production package. */}
          {item.video_plan && (
            <section className="panel p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="label">
                  Video · {item.video_plan.total_duration_seconds}s ·{' '}
                  {item.video_plan.scenes.length} scenes
                </span>
                <span
                  className={[
                    'border px-2 py-1 font-mono text-[10px] uppercase tracking-wider',
                    item.video_plan.render_status === 'rendered'
                      ? 'border-live/50 text-live'
                      : 'border-warn/50 text-warn',
                  ].join(' ')}
                >
                  {item.video_plan.render_status.replace('_', ' ')}
                </span>
              </div>

              {item.video_plan.render_note && (
                <p className="mt-2 text-sm text-dim">{item.video_plan.render_note}</p>
              )}

              <ol className="mt-4 space-y-3">
                {item.video_plan.scenes.map((s) => (
                  <li key={s.index} className="border-l-2 border-orange/40 pl-3">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-orange">
                      {s.duration_seconds}s
                      {s.screen_reference && ` · ${s.screen_reference}`}
                    </p>
                    <p className="mt-0.5 text-sm text-mist">{s.visual}</p>
                    {s.on_screen_text && (
                      <p className="mt-0.5 font-display text-sm font-bold tracking-tight text-mist">
                        “{s.on_screen_text}”
                      </p>
                    )}
                    <p className="text-sm text-dim">{s.narration}</p>
                  </li>
                ))}
              </ol>

              <p className="mt-4 border-t border-edge pt-3 text-sm text-dim">
                <span className="label">Music</span>
                <br />
                {item.video_plan.music_direction}
              </p>
            </section>
          )}

          {/* Quality control. */}
          <section className="panel p-5">
            <div className="flex items-center justify-between">
              <span className="label">Quality control</span>
              {item.qc && (
                <span
                  className={[
                    'font-mono text-[11px]',
                    item.qc.passed ? 'text-live' : 'text-fail',
                  ].join(' ')}
                >
                  {item.qc.passed ? 'PASSED' : 'BLOCKED'} · score {item.qc.score}
                </span>
              )}
            </div>

            {!item.qc ? (
              <p className="mt-3 text-sm text-dim">Not checked yet.</p>
            ) : blocks.length === 0 && warns.length === 0 ? (
              <p className="mt-3 text-sm text-live">All checks passed.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {[...blocks, ...warns].map((f, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span
                      className={[
                        'mt-0.5 shrink-0 font-mono text-[10px] uppercase',
                        f.severity === 'block' ? 'text-fail' : 'text-warn',
                      ].join(' ')}
                    >
                      {f.severity}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm text-mist">{f.message}</span>
                      <span className="block font-mono text-[10px] text-dimmer">
                        check: {f.check}
                        {f.excerpt && ` · “${f.excerpt}”`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Delivery. */}
          <section className="panel p-5">
            <span className="label">Delivery</span>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Scheduled for">
                {item.scheduled_for
                  ? new Date(item.scheduled_for).toLocaleString('en-US', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: safeZone(context.timezone),
                    })
                  : '—'}
              </Row>
              {scheduled && (
                <>
                  <Row label="Attempts">{scheduled.attempts}</Row>
                  {scheduled.last_error && (
                    <Row label="Last error">
                      <span className="text-fail">{scheduled.last_error}</span>
                    </Row>
                  )}
                </>
              )}
              {published && (
                <>
                  <Row label="Published">
                    {new Date(published.published_at).toLocaleString('en-US', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </Row>
                  <Row label="Platform id">
                    <code className="font-mono text-[11px]">{published.external_id}</code>
                  </Row>
                  {published.permalink && (
                    <Row label="Link">
                      <a
                        href={published.permalink}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-orange hover:underline"
                      >
                        Open on {item.platform} ↗
                      </a>
                    </Row>
                  )}
                </>
              )}
            </dl>
          </section>

          {error && <p className="text-sm text-fail">{error}</p>}
          {note && <p className="text-sm text-live">{note}</p>}

          {!locked && (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => approve(false)} disabled={busy} className="btn-send text-sm">
                {busy ? '…' : 'APPROVE & SCHEDULE'}
              </button>
              <button onClick={() => approve(true)} disabled={busy} className="btn-ghost text-sm">
                SEND IT NOW →
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="label mb-1">{label}</p>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-edge pb-2 last:border-b-0">
      <dt className="label">{label}</dt>
      <dd className="text-right text-mist">{children}</dd>
    </div>
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
