'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { BrandProfile } from '@/lib/types';

/**
 * The project's visual identity, with its provenance, and editable.
 *
 * Two things this screen has to do that a plain form does not.
 *
 * It has to say *where each value came from*. Repository analysis gets things
 * wrong — a demo page's accent read as the brand colour, a vendored stylesheet
 * picked over the product's own — and a founder looking at a wrong colour can
 * only act on it if they can see which file produced it. So every field
 * carries its source underneath.
 *
 * And it has to distinguish "we read this" from "we never found this". A
 * neutral card looks perfectly deliberate, so an undiscovered palette is
 * invisible unless it is named. Nothing here is ever shown as a value the
 * repository did not state.
 */
export function BrandIdentityPanel({
  projectId,
  projectName,
  brand,
  discovery,
}: {
  projectId: string;
  projectName: string;
  brand: BrandProfile | null;
  discovery: { read_from: string[]; not_found: string[] } | null;
}) {
  const router = useRouter();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!brand) {
    return (
      <Panel title="Brand identity">
        <p className="text-dim">
          No brand profile yet. It is built from the repository analysis — run that first.
        </p>
      </Panel>
    );
  }

  const locked = new Set(brand.locked_fields ?? []);
  const value = (field: string) =>
    edits[field] ?? String((brand as unknown as Record<string, unknown>)[field] ?? '');

  const set = (field: string, v: string) => {
    setEdits((e) => ({ ...e, [field]: v }));
    setSaved(false);
  };

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/brand`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(edits),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? 'Could not save');
      setEdits({});
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const dirty = Object.keys(edits).length > 0;

  return (
    <Panel title={`${projectName} — brand identity`}>
      <p className="text-dim">
        Read from {projectName}&rsquo;s own repository. Every post and every generated image uses
        this — not FullSend&rsquo;s. Correct anything that is wrong; a field you edit is never
        overwritten by a later analysis.
      </p>

      {discovery && discovery.read_from.length > 0 && (
        <p className="mt-3 font-mono text-[10px] text-dimmer">
          Read from: {discovery.read_from.join(', ')}
        </p>
      )}

      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        <Color field="primary_color" label="Primary" brand={brand} value={value} set={set} locked={locked} />
        <Color field="secondary_color" label="Secondary" brand={brand} value={value} set={set} locked={locked} />
        <Color field="accent_color" label="Accent" brand={brand} value={value} set={set} locked={locked} />
        <Color field="background_color" label="Background" brand={brand} value={value} set={set} locked={locked} />
        <Color field="text_color" label="Text" brand={brand} value={value} set={set} locked={locked} />
      </div>

      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        <Text field="heading_font" label="Heading typeface" placeholder="Not found in the repository" brand={brand} value={value} set={set} locked={locked} />
        <Text field="body_font" label="Body typeface" placeholder="Not found in the repository" brand={brand} value={value} set={set} locked={locked} />
        <Text field="logo_url" label="Logo" placeholder="Not found in the repository" brand={brand} value={value} set={set} locked={locked} />
        <Text field="brand_name" label="Brand name" placeholder={projectName} brand={brand} value={value} set={set} locked={locked} />
      </div>

      {brand.logo_url && (
        <div className="mt-5 flex items-center gap-3 border border-edge bg-charcoal p-3">
          {/* The product's own mark, served from its repository rather than copied. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={brand.logo_url} alt={`${projectName} logo`} className="h-8 w-auto" />
          <span className="font-mono text-[10px] text-dimmer">{brand.identity_sources?.logo_url}</span>
        </div>
      )}

      {discovery && discovery.not_found.length > 0 && (
        <p className="mt-5 border-l-2 border-edge pl-3 font-mono text-[11px] leading-relaxed text-dim">
          Not stated anywhere in the repository: {discovery.not_found.join(', ')}. FullSend uses a
          neutral for these rather than guessing — fill them in above and it will use yours.
        </p>
      )}

      {error && <p className="mt-4 text-sm text-fail">{error}</p>}
      {saved && !dirty && (
        <p className="mt-4 text-sm text-live">
          Saved. These fields are now yours — re-analysis will leave them alone.
        </p>
      )}

      <button
        type="button"
        onClick={save}
        disabled={!dirty || saving}
        className="mt-5 border border-edge bg-charcoal px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-mist disabled:opacity-40"
      >
        {saving ? 'Saving…' : 'Save brand identity'}
      </button>
    </Panel>
  );
}

/* ── Fields ─────────────────────────────────────────────────────────────── */

interface FieldProps {
  field: string;
  label: string;
  brand: BrandProfile;
  value: (f: string) => string;
  set: (f: string, v: string) => void;
  locked: Set<string>;
  placeholder?: string;
}

function Color({ field, label, brand, value, set, locked }: FieldProps) {
  const current = value(field);
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="mt-1 flex items-center gap-2">
        <span
          aria-hidden
          className="h-8 w-8 shrink-0 border border-edge"
          // An unset colour shows as a hatched blank rather than as black,
          // which would read as a real decision.
          style={{ background: current || 'repeating-linear-gradient(45deg,#222,#222 4px,#161616 4px,#161616 8px)' }}
        />
        <input
          value={current}
          onChange={(e) => set(field, e.target.value)}
          placeholder="Not found"
          className="w-full border border-edge bg-charcoal px-2 py-1.5 font-mono text-[11px] text-mist"
        />
      </div>
      <Provenance field={field} brand={brand} locked={locked} />
    </label>
  );
}

function Text({ field, label, brand, value, set, locked, placeholder }: FieldProps) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input
        value={value(field)}
        onChange={(e) => set(field, e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full border border-edge bg-charcoal px-2 py-1.5 font-mono text-[11px] text-mist"
      />
      <Provenance field={field} brand={brand} locked={locked} />
    </label>
  );
}

/** Where this value came from — a file, a person, or nowhere yet. */
function Provenance({
  field,
  brand,
  locked,
}: {
  field: string;
  brand: BrandProfile;
  locked: Set<string>;
}) {
  const source = brand.identity_sources?.[field];
  if (locked.has(field)) {
    return <span className="mt-1 block font-mono text-[10px] text-live">Yours — analysis will not change it</span>;
  }
  if (source) {
    return <span className="mt-1 block font-mono text-[10px] text-dimmer">from {source}</span>;
  }
  return <span className="mt-1 block font-mono text-[10px] text-dimmer">not found in the repository</span>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 border border-edge bg-ink p-5 sm:p-6">
      <h2 className="font-display text-lg font-extrabold tracking-tight text-mist">{title}</h2>
      <div className="mt-3 text-sm">{children}</div>
    </section>
  );
}
