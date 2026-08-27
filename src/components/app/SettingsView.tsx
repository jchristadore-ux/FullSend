'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Capabilities } from '@/lib/env';
import type { AutopilotMode, Project, Repository, Settings } from '@/lib/types';

const MODES: { value: AutopilotMode; title: string; body: string; recommended?: boolean }[] = [
  {
    value: 'manual',
    title: 'MANUAL',
    body: 'Nothing publishes without your approval. FullSend still generates and schedules.',
  },
  {
    value: 'hybrid',
    title: 'HYBRID',
    body: 'Normal content publishes automatically. Promotional content waits for you.',
  },
  {
    value: 'full_send',
    title: 'FULL SEND',
    body: 'FullSend generates, schedules, publishes, analyses and optimises on its own.',
    recommended: true,
  },
];

export function SettingsView({
  project,
  settings,
  repository,
  spend,
  plan,
  capabilities,
  userEmail,
}: {
  project: Project;
  settings: Settings | null;
  repository: Repository | null;
  spend: { total: number; calls: number; cacheHits: number; byTask: Record<string, number> };
  plan: { tier: string; name: string; billingEnabled: boolean };
  capabilities: Capabilities;
  userEmail: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<AutopilotMode>(project.autopilot_mode);
  const [dailyCap, setDailyCap] = useState(settings?.daily_post_cap ?? 3);
  const [requireApproval, setRequireApproval] = useState(
    settings?.require_approval_for_promotion ?? true,
  );
  const [trends, setTrends] = useState(settings?.trend_participation ?? true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function deleteProject() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `The server refused the delete (${res.status}).`);
      }
      // Onboarding is where a founder with no project belongs.
      router.replace('/onboarding');
      router.refresh();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autopilot_mode: mode,
          daily_post_cap: dailyCap,
          require_approval_for_promotion: requireApproval,
          trend_participation: trends,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.remedy ?? json.message ?? 'Could not save');
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const costPerPost = spend.calls ? spend.total / Math.max(1, spend.calls) : 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
      <span className="label">Settings</span>
      <h1 className="mt-2 font-display text-3xl font-extrabold tracking-crush text-mist sm:text-4xl">
        {project.name}
      </h1>
      {repository && (
        <a
          href={repository.url}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-1 inline-block font-mono text-xs text-dimmer hover:text-orange"
        >
          {repository.owner}/{repository.name} ↗
        </a>
      )}

      {/* Autopilot mode. */}
      <section className="mt-8">
        <span className="label">Autopilot mode</span>
        <div className="mt-3 space-y-px bg-edge">
          {MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setMode(m.value)}
              className={[
                'flex w-full items-start gap-4 p-4 text-left transition-colors',
                mode === m.value ? 'bg-orange/10 ring-1 ring-inset ring-orange' : 'bg-charcoal hover:bg-charcoal-raised',
              ].join(' ')}
            >
              <span
                className={[
                  'mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2',
                  mode === m.value ? 'border-orange bg-orange' : 'border-edge',
                ].join(' ')}
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-sm font-extrabold tracking-tight text-mist">
                    {m.title}
                  </span>
                  {m.recommended && (
                    <span className="bg-orange px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-widest text-void">
                      RECOMMENDED
                    </span>
                  )}
                </span>
                <span className="mt-1 block text-sm text-dim">{m.body}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Publishing rules. */}
      <section className="panel mt-6 p-5">
        <span className="label">Publishing rules</span>
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-mist">Daily post cap</p>
              <p className="text-sm text-dim">Most posts FullSend will publish in one day.</p>
            </div>
            <input
              type="number"
              min={1}
              max={10}
              value={dailyCap}
              onChange={(e) => setDailyCap(Number(e.target.value))}
              className="w-20 shrink-0"
            />
          </div>

          <Toggle
            checked={requireApproval}
            onChange={setRequireApproval}
            title="Promotional content needs approval"
            body="Even on Full Send, direct promotion waits for a human. Recommended."
          />

          <Toggle
            checked={trends}
            onChange={setTrends}
            title="Participate in trends"
            body="FullSend only joins formats your product can genuinely take part in."
          />
        </div>
      </section>

      {error && <p className="mt-4 text-sm text-fail">{error}</p>}
      {saved && <p className="mt-4 text-sm text-live">Saved.</p>}

      <button onClick={save} disabled={busy} className="btn-send mt-6">
        {busy ? 'SAVING…' : 'SAVE SETTINGS'}
      </button>

      {/* Cost. */}
      <section className="panel mt-8 p-5">
        <span className="label">AI cost</span>
        <div className="mt-3 grid grid-cols-3 gap-4">
          <Stat label="This project" value={`$${spend.total.toFixed(4)}`} />
          <Stat label="Per generation" value={`$${costPerPost.toFixed(5)}`} />
          <Stat label="Cache hits" value={`${spend.cacheHits}/${spend.calls}`} />
        </div>
        <p className="mt-4 font-mono text-[10px] leading-relaxed text-dimmer">
          FullSend routes simple work to cheap models and caches analysis, so re-running onboarding
          or regenerating a strategy costs nothing the second time.
        </p>
      </section>

      {/* Plan. */}
      <section className="panel mt-6 p-5">
        <span className="label">Plan</span>
        <p className="mt-2 font-display text-xl font-extrabold tracking-tight text-mist">
          {plan.name}
        </p>
        <p className="mt-1 text-sm text-dim">
          {plan.billingEnabled
            ? 'Billing is active on this deployment.'
            : 'Billing is switched off on this deployment — every feature is available and no limits are enforced.'}
        </p>
      </section>

      {/* Capabilities — honest about what is and is not wired up. */}
      <section className="panel mt-6 p-5">
        <span className="label">This deployment</span>
        <ul className="mt-3 space-y-2">
          <Cap ok={capabilities.database === 'supabase'} label="Persistent database (Supabase)" off="In-memory store — data resets when the server restarts" />
          <Cap ok={capabilities.auth} label="Supabase Auth" off="Local development sessions" />
          <Cap ok={capabilities.ai} label="Language-model generation" off="Deterministic composer — real output, rule-based" />
          <Cap ok={capabilities.storage} label="Media hosting for publishing" off="Not configured — publishing needs a public media URL" />
          <Cap ok={capabilities.instagram} label="Instagram app credentials" off="Not configured" />
          <Cap ok={capabilities.tiktok} label="TikTok app credentials" off="Not configured" />
          <Cap ok={capabilities.tiktokPublicPosting} label="TikTok audited (public posts)" off="Unaudited — posts publish as SELF_ONLY" />
          <Cap ok={capabilities.videoRender} label="Automatic video rendering" off="Production packages only" />
          <Cap ok={capabilities.encryption} label="Token encryption key set" off="Required before connecting an account" />
        </ul>
      </section>

      {/*
        Deleting a project is how a founder actually exercises the deletion
        right the privacy policy promises, so it has to be a control they can
        find — not just an API endpoint. Typing the name is the guard: this
        cascades to every row hanging off the project and cannot be undone.
      */}
      <section className="panel mt-6 border-fail/40 p-5">
        <span className="label text-fail">Delete this project</span>
        <p className="mt-2 text-sm text-dim">
          Removes the repository analysis, strategy, every piece of content, the connected accounts
          and their tokens, the schedule, and all collected analytics. Posts already live on
          Instagram or TikTok stay up — delete those on the platform.
        </p>
        <p className="mt-2 text-sm text-dim">
          Type <strong className="text-mist">{project.name}</strong> to confirm.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            placeholder={project.name}
            aria-label={`Type ${project.name} to confirm deletion`}
            className="min-w-0 flex-1 border border-edge bg-void px-3 py-2 font-mono text-sm text-mist placeholder:text-dimmer focus:border-fail focus:outline-none"
          />
          <button
            onClick={deleteProject}
            disabled={confirmName !== project.name || deleting}
            className="border border-fail px-4 py-2 font-mono text-xs uppercase tracking-wider text-fail transition-colors hover:bg-fail hover:text-void disabled:pointer-events-none disabled:opacity-40"
          >
            {deleting ? 'Deleting…' : 'Delete forever'}
          </button>
        </div>
        {deleteError && <p className="mt-2 text-sm text-fail">{deleteError}</p>}
      </section>

      <section className="mt-8 border-t border-edge pt-6">
        <p className="font-mono text-[11px] text-dimmer">{userEmail}</p>
        <form action="/api/auth/signout" method="post" className="mt-2">
          <button type="submit" className="btn-quiet text-xs">
            Sign out
          </button>
        </form>
      </section>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  title,
  body,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  body: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-sm font-semibold text-mist">{title}</span>
        <span className="block text-sm text-dim">{body}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-5 w-5 shrink-0 accent-orange"
      />
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="label">{label}</p>
      <p className="stat mt-0.5 text-lg text-mist">{value}</p>
    </div>
  );
}

function Cap({ ok, label, off }: { ok: boolean; label: string; off: string }) {
  return (
    <li className="flex items-start gap-2.5 text-sm">
      <span className={ok ? 'font-mono text-xs text-live' : 'font-mono text-xs text-warn'}>
        {ok ? '✓' : '!'}
      </span>
      <span className={ok ? 'text-dim' : 'text-dimmer'}>
        {label}
        {!ok && <span className="block text-xs">{off}</span>}
      </span>
    </li>
  );
}
