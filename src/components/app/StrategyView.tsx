'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type {
  BrandProfile,
  Campaign,
  ContentMix,
  ContentPillar,
  MarketingStrategy,
  Persona,
  PillarType,
} from '@/lib/types';

const PILLAR_LABEL: Record<PillarType, string> = {
  education: 'Education / value',
  product_demo: 'Product demonstration',
  entertainment: 'Entertainment / personality',
  social_proof: 'Social proof',
  promotion: 'Direct promotion',
};

/**
 * The strategy, editable then approvable. Approving is what unlocks the
 * machine, so the button says exactly that.
 */
export function StrategyView({
  projectId,
  projectName,
  strategy,
  pillars,
  campaigns,
  brand,
  personas,
}: {
  projectId: string;
  projectName: string;
  strategy: MarketingStrategy;
  pillars: ContentPillar[];
  campaigns: Campaign[];
  brand: BrandProfile | null;
  personas: Persona[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [positioning, setPositioning] = useState(strategy.positioning);
  const [valueProp, setValueProp] = useState(strategy.value_proposition);
  const [mix, setMix] = useState<ContentMix>(strategy.content_mix);
  const [igPerWeek, setIgPerWeek] = useState(strategy.posting_cadence.instagram_per_week);
  const [ttPerWeek, setTtPerWeek] = useState(strategy.posting_cadence.tiktok_per_week);

  const mixTotal = Object.values(mix).reduce((a, b) => a + b, 0);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/strategy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          editing
            ? {
                positioning,
                value_proposition: valueProp,
                content_mix: mix,
                posting_cadence: {
                  ...strategy.posting_cadence,
                  instagram_per_week: igPerWeek,
                  tiktok_per_week: ttPerWeek,
                },
              }
            : {},
        ),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.remedy ?? json.message ?? 'Could not approve');

      await fetch(`/api/projects/${projectId}/tick`, { method: 'POST' });
      router.push('/app/calendar');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rebuild() {
    setBusy(true);
    try {
      await fetch(`/api/projects/${projectId}/strategy`, { method: 'PUT' });
      await fetch(`/api/projects/${projectId}/tick`, { method: 'POST' });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className="label">Marketing Strategy · v{strategy.version}</span>
          <h1 className="mt-2 font-display text-3xl font-extrabold tracking-crush text-mist sm:text-4xl">
            How FullSend markets {projectName}.
          </h1>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setEditing((v) => !v)} className="btn-ghost !px-4 !py-2 text-xs">
            {editing ? 'CANCEL EDIT' : 'EDIT'}
          </button>
          <button onClick={rebuild} disabled={busy} className="btn-ghost !px-4 !py-2 text-xs">
            REBUILD
          </button>
        </div>
      </div>

      {strategy.approved && (
        <p className="mt-4 inline-flex items-center gap-2 border border-live/40 bg-live/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-live">
          <span className="dot-live" /> Approved
        </p>
      )}

      {/* Positioning. */}
      <Panel title="Positioning">
        {editing ? (
          <textarea
            value={positioning}
            onChange={(e) => setPositioning(e.target.value)}
            rows={3}
            className="w-full text-sm"
          />
        ) : (
          <p className="font-display text-lg font-bold leading-snug tracking-tight text-mist">
            {strategy.positioning}
          </p>
        )}
      </Panel>

      <Panel title="Value proposition">
        {editing ? (
          <textarea
            value={valueProp}
            onChange={(e) => setValueProp(e.target.value)}
            rows={2}
            className="w-full text-sm"
          />
        ) : (
          <p className="text-mist">{strategy.value_proposition}</p>
        )}
      </Panel>

      <Panel title="Audience">
        <p className="text-dim">{strategy.audience_summary}</p>
        {personas.length > 0 && (
          <ul className="mt-4 space-y-3">
            {personas.map((p) => (
              <li key={p.id} className="border-l-2 border-edge pl-3.5">
                <p className="font-display text-sm font-bold tracking-tight text-mist">
                  {p.name} <span className="font-sans font-normal text-dimmer">· {p.role}</span>
                </p>
                <p className="text-sm text-dim">{p.description}</p>
                {p.pain_points.length > 0 && (
                  <p className="mt-1 font-mono text-[10px] text-dimmer">
                    pain: {p.pain_points.join(' · ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {strategy.pain_points.length > 0 && (
        <Panel title="Pain points">
          <ul className="space-y-1.5">
            {strategy.pain_points.map((p) => (
              <li key={p} className="flex gap-2 text-sm text-dim">
                <span className="font-mono text-xs text-orange">›</span>
                {p}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {strategy.differentiators.length > 0 && (
        <Panel title="Differentiators">
          <ul className="space-y-1.5">
            {strategy.differentiators.map((d) => (
              <li key={d} className="flex gap-2 text-sm text-dim">
                <span className="font-mono text-xs text-orange">›</span>
                {d}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* Content mix. */}
      <Panel
        title="Content mix"
        note={editing && mixTotal !== 100 ? `Totals ${mixTotal}% — will be normalised to 100%` : undefined}
      >
        <div className="space-y-3">
          {(Object.keys(mix) as PillarType[]).map((key) => (
            <div key={key} className="flex items-center gap-3">
              <span className="w-44 shrink-0 text-sm text-dim">{PILLAR_LABEL[key]}</span>
              {editing ? (
                <input
                  type="range"
                  min={0}
                  max={70}
                  value={mix[key]}
                  onChange={(e) => setMix({ ...mix, [key]: Number(e.target.value) })}
                  className="flex-1 !border-0 !bg-transparent !p-0 accent-orange"
                />
              ) : (
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-edge">
                  <span
                    className="block h-full bg-orange"
                    style={{ width: `${strategy.content_mix[key]}%` }}
                  />
                </span>
              )}
              <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-mist">
                {mix[key]}%
              </span>
            </div>
          ))}
        </div>
      </Panel>

      {/* Cadence. */}
      <Panel title="Posting cadence">
        <div className="grid gap-4 sm:grid-cols-2">
          <Cadence
            label="Instagram / week"
            value={igPerWeek}
            editing={editing}
            onChange={setIgPerWeek}
          />
          <Cadence label="TikTok / week" value={ttPerWeek} editing={editing} onChange={setTtPerWeek} />
        </div>
        {strategy.posting_cadence.best_times.length > 0 && (
          <p className="mt-4 font-mono text-[11px] text-dimmer">
            Best times:{' '}
            {strategy.posting_cadence.best_times
              .map((t) => `${DAYS[t.day]} ${String(t.hour).padStart(2, '0')}:00 ${t.platform}`)
              .join(' · ')}
          </p>
        )}
      </Panel>

      <Panel title="Content pillars">
        <ul className="space-y-3">
          {pillars.map((p) => (
            <li key={p.id} className="border-l-2 border-orange/50 pl-3.5">
              <p className="font-display text-sm font-bold tracking-tight text-mist">
                {p.name}{' '}
                <span className="font-mono text-[10px] font-normal text-orange">{p.weight}%</span>
              </p>
              <p className="text-sm text-dim">{p.description}</p>
              {p.example_topics.length > 0 && (
                <p className="mt-1 font-mono text-[10px] text-dimmer">
                  {p.example_topics.join(' · ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Campaigns">
        <ul className="space-y-3">
          {campaigns.map((c) => (
            <li key={c.id} className="border-l-2 border-edge pl-3.5">
              <p className="font-display text-sm font-bold tracking-tight text-mist">
                {c.name}{' '}
                <span className="font-mono text-[10px] font-normal uppercase text-dimmer">
                  {c.status}
                </span>
              </p>
              <p className="text-sm text-dim">{c.angle}</p>
              <p className="mt-1 font-mono text-[10px] text-dimmer">
                Hypothesis: {c.hypothesis}
              </p>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Growth strategy">
        <p className="text-dim">{strategy.growth_strategy}</p>
      </Panel>

      <Panel title="Call-to-action strategy">
        <div className="flex flex-wrap gap-2">
          {strategy.cta_strategy.map((c) => (
            <span
              key={c}
              className="border border-edge bg-charcoal px-2.5 py-1.5 font-mono text-[11px] text-mist"
            >
              {c}
            </span>
          ))}
        </div>
      </Panel>

      {brand && (
        <Panel title="Brand voice">
          <p className="text-mist">{brand.voice}</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="label">Words to use</p>
              <p className="mt-1 font-mono text-[11px] leading-relaxed text-live">
                {brand.words_to_use.join(' · ')}
              </p>
            </div>
            <div>
              <p className="label">Words to avoid</p>
              <p className="mt-1 font-mono text-[11px] leading-relaxed text-fail">
                {brand.words_to_avoid.slice(0, 12).join(' · ')}
              </p>
            </div>
          </div>
          <p className="mt-4 font-mono text-[10px] text-dimmer">
            Every generated post is checked against this profile before it can be scheduled.
          </p>
        </Panel>
      )}

      {error && <p className="mt-5 text-sm text-fail">{error}</p>}

      <div className="mt-10 border-t border-edge pt-8">
        <p className="font-display text-2xl font-extrabold tracking-tight text-mist">
          Ready to send?
        </p>
        <p className="mt-2 text-dim">
          Approving builds your first 30 days of content and puts it on the calendar.
        </p>
        <button onClick={approve} disabled={busy} className="btn-send mt-5 text-base">
          {busy ? 'SENDING…' : 'FULL SEND →'}
        </button>
      </div>
    </div>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel mt-5 p-5 sm:p-6">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="label">{title}</span>
        {note && <span className="font-mono text-[10px] text-warn">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Cadence({
  label,
  value,
  editing,
  onChange,
}: {
  label: string;
  value: number;
  editing: boolean;
  onChange: (n: number) => void;
}) {
  return (
    <div>
      <p className="label">{label}</p>
      {editing ? (
        <input
          type="number"
          min={0}
          max={14}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="mt-1 w-24"
        />
      ) : (
        <p className="stat mt-1 text-2xl text-mist">{value}</p>
      )}
    </div>
  );
}
