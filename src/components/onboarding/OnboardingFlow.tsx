'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Capabilities } from '@/lib/env';
import type { AppScreen, Persona, ProductAnalysis, Repository } from '@/lib/types';
import { failureRemedy } from '@/lib/jobs/failure-remedy';

/**
 * "What's your app?" → "FullSend is looking under the hood…" → "We've got it."
 *
 * The progress steps are driven by the real job state on the server, not a
 * timer: a step only ticks over when that work has genuinely happened.
 */

const STEPS = [
  'Reading repository',
  'Understanding product',
  'Identifying audience',
  'Finding differentiators',
  'Building positioning',
  'Creating content strategy',
  'Planning first campaign',
];

type Phase = 'input' | 'working' | 'done' | 'error';

interface AnalyzeState {
  status: string;
  repository: Repository | null;
  analysis: ProductAnalysis | null;
  personas: Persona[];
  screenshots: { withImages: number; describedOnly: number; note: string } | null;
  jobs: {
    analyze: { status: string; error: string | null } | null;
    strategy: { status: string; error: string | null } | null;
  };
}

export function OnboardingFlow({ capabilities }: { capabilities: Capabilities }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('input');
  const [repo, setRepo] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [state, setState] = useState<AnalyzeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remedy, setRemedy] = useState<string | null>(null);
  const [reachedStep, setReachedStep] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  /** Maps real server state onto the visible checklist. */
  const stepFor = useCallback((s: AnalyzeState): number => {
    if (s.jobs.strategy?.status === 'succeeded') return STEPS.length;
    if (s.jobs.strategy?.status === 'running') return 6;
    if (s.analysis) return 5;
    if (s.jobs.analyze?.status === 'running') return 2;
    if (s.repository) return 1;
    return 0;
  }, []);

  const poll = useCallback(
    async (id: string) => {
      try {
        // The queue is drained by cron in production; nudge it here so
        // onboarding is not waiting on the next scheduled tick.
        await fetch(`/api/projects/${id}/tick`, { method: 'POST' }).catch(() => {});

        const res = await fetch(`/api/projects/${id}/analyze`, { cache: 'no-store' });
        const json: AnalyzeState = await res.json();
        if (!res.ok) throw new Error((json as never as { message: string }).message);

        setState(json);
        setReachedStep((prev) => Math.max(prev, stepFor(json)));

        const failed =
          json.jobs.analyze?.status === 'dead' || json.jobs.strategy?.status === 'dead';
        if (failed) {
          stopPolling();
          const message =
            json.jobs.analyze?.error ?? json.jobs.strategy?.error ?? 'Analysis could not finish';
          setError(message);
          // Derived from what actually failed. A fixed line here told everyone
          // to check their repository, including when the repository was fine
          // and the AI account had simply run out of credit.
          setRemedy(failureRemedy(message));
          setPhase('error');
          return;
        }

        if (json.analysis && json.jobs.strategy?.status === 'succeeded') {
          stopPolling();
          setReachedStep(STEPS.length);
          setPhase('done');
        }
      } catch (e) {
        stopPolling();
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    },
    [stepFor, stopPolling],
  );

  async function analyze(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRemedy(null);
    setPhase('working');
    setReachedStep(0);

    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repository: repo, timezone: guessTimezone() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? 'Could not start the analysis');
        setRemedy(json.remedy ?? null);
        setPhase('error');
        return;
      }

      setProjectId(json.project.id);
      await poll(json.project.id);
      pollRef.current = setInterval(() => poll(json.project.id), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }

  if (phase === 'input' || phase === 'error') {
    return (
      <div className="animate-throttle-in">
        <h1 className="font-display text-5xl font-extrabold leading-[0.92] tracking-crush text-mist sm:text-6xl">
          What&rsquo;s your app?
        </h1>
        <p className="mt-5 text-lg text-dim">
          Paste your GitHub repository. FullSend reads the code, works out what your product
          actually does, and builds the marketing from there.
        </p>

        <form onSubmit={analyze} className="mt-9">
          <label htmlFor="repo" className="label">
            Paste your GitHub repository
          </label>
          <input
            id="repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="https://github.com/you/your-app"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="mt-2 w-full !px-4 !py-4 font-mono text-base"
          />

          {error && (
            <div className="mt-4 border border-fail/50 bg-fail/10 px-4 py-3">
              <p className="text-sm font-semibold text-fail">{error}</p>
              {remedy && <p className="mt-1 text-sm text-dim">{remedy}</p>}
            </div>
          )}

          <button type="submit" disabled={repo.trim().length < 3} className="btn-send mt-5 text-base">
            ANALYZE IT →
          </button>
        </form>

        <div className="mt-10 border-t border-edge pt-6">
          <p className="label">What FullSend can do right now</p>
          <ul className="mt-3 space-y-1.5">
            <Capability ok={capabilities.github} label="Read public GitHub repositories" />
            <Capability
              ok={capabilities.ai}
              label="Analyse with a language model"
              fallback="Running the deterministic composer — real output, rule-based rather than model-written"
            />
            <Capability
              ok={capabilities.instagram}
              label="Publish to Instagram"
              fallback="Needs a Meta app — FullSend walks you through it"
            />
            <Capability
              ok={capabilities.tiktok}
              label="Publish to TikTok"
              fallback="Needs a TikTok developer app — FullSend walks you through it"
            />
            <Capability
              ok={capabilities.storage}
              label="Host creative for platforms to fetch"
              fallback="Needs Supabase Storage before publishing can work"
            />
          </ul>
        </div>
      </div>
    );
  }

  if (phase === 'working') {
    return (
      <div className="animate-throttle-in">
        <p className="label text-orange">FULLSEND IS LOOKING UNDER THE HOOD…</p>
        <h1 className="mt-4 font-display text-4xl font-extrabold leading-[0.95] tracking-crush text-mist sm:text-5xl">
          Reading {state?.repository?.name ?? 'your repository'}
        </h1>

        <ol className="mt-10 space-y-0">
          {STEPS.map((step, i) => {
            const done = i < reachedStep;
            const active = i === reachedStep;
            return (
              <li
                key={step}
                className={[
                  'flex items-center gap-3.5 border-b border-edge py-3.5 transition-opacity duration-300',
                  done || active ? 'opacity-100' : 'opacity-35',
                ].join(' ')}
              >
                <span
                  className={[
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-sm font-mono text-[11px] font-bold',
                    done
                      ? 'bg-live/20 text-live'
                      : active
                        ? 'bg-orange text-void animate-send-pulse'
                        : 'bg-charcoal text-dimmer',
                  ].join(' ')}
                >
                  {done ? '✓' : active ? '•' : ''}
                </span>
                <span
                  className={[
                    'font-display font-bold tracking-tight',
                    done ? 'text-mist' : active ? 'text-orange' : 'text-dimmer',
                  ].join(' ')}
                >
                  {step}
                </span>
              </li>
            );
          })}
        </ol>

        <p className="mt-8 font-mono text-xs text-dimmer">
          This runs in the background. You can close this tab — FullSend keeps working.
        </p>
      </div>
    );
  }

  /* Done. */
  const analysis = state!.analysis!;
  return (
    <div className="animate-throttle-in">
      <p className="label text-live">ANALYSIS COMPLETE</p>
      <h1 className="mt-4 font-display text-5xl font-extrabold leading-[0.9] tracking-crush text-mist sm:text-6xl">
        We&rsquo;ve got it.
      </h1>

      <div className="panel mt-8 p-6">
        <span className="label">What FullSend thinks your app is</span>
        <p className="mt-3 font-display text-2xl font-extrabold leading-tight tracking-tight text-mist">
          {analysis.one_liner}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-dim">{analysis.what_it_does}</p>

        <dl className="mt-6 grid gap-4 border-t border-edge pt-5 sm:grid-cols-2">
          <Fact label="Category" value={analysis.category} />
          <Fact label="Maturity" value={analysis.maturity} />
          <Fact label="Built with" value={analysis.tech_stack.slice(0, 4).join(', ') || '—'} />
          <Fact label="Confidence" value={`${Math.round(analysis.confidence * 100)}%`} />
        </dl>
      </div>

      <Section title="Features it found" count={analysis.features.length}>
        <ul className="space-y-2.5">
          {analysis.features.slice(0, 6).map((f) => (
            <li key={f.name} className="border-l-2 border-orange/50 pl-3.5">
              <p className="font-display text-sm font-bold tracking-tight text-mist">{f.name}</p>
              <p className="text-sm text-dim">{f.description}</p>
              {f.evidence.length > 0 && (
                <p className="mt-0.5 font-mono text-[10px] text-dimmer">
                  evidence: {f.evidence.slice(0, 2).join(', ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Who needs it" count={state!.personas.length}>
        <ul className="space-y-3">
          {state!.personas.map((p) => (
            <li key={p.id} className="border-l-2 border-edge pl-3.5">
              <p className="font-display text-sm font-bold tracking-tight text-mist">
                {p.name} <span className="font-sans font-normal text-dimmer">· {p.role}</span>
              </p>
              <p className="text-sm text-dim">{p.description}</p>
              {p.pain_points.length > 0 && (
                <p className="mt-1 font-mono text-[10px] text-dimmer">
                  pain: {p.pain_points.slice(0, 2).join(' · ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      </Section>

      {analysis.screens.length > 0 && (
        <Section title="Screens it can film" count={analysis.screens.length}>
          <div className="flex flex-wrap gap-2">
            {(analysis.screens as AppScreen[]).map((s) => (
              <span
                key={s.name}
                className="border border-edge bg-charcoal px-2.5 py-1.5 font-mono text-[11px] text-mist"
              >
                {s.name}
                {s.image_url && <span className="ml-1.5 text-live">◆</span>}
              </span>
            ))}
          </div>
          {state!.screenshots && (
            <p className="mt-3 font-mono text-[11px] leading-relaxed text-dimmer">
              {state!.screenshots.note}
            </p>
          )}
        </Section>
      )}

      <Section title="What it will never claim" count={analysis.not_capabilities.length}>
        <ul className="space-y-1.5">
          {analysis.not_capabilities.map((n) => (
            <li key={n} className="flex gap-2 text-sm text-dim">
              <span className="font-mono text-xs text-fail">✗</span>
              {n}
            </li>
          ))}
        </ul>
        <p className="mt-3 font-mono text-[11px] text-dimmer">
          Quality control blocks any post that crosses these lines.
        </p>
      </Section>

      <div className="mt-10 border-t border-edge pt-8">
        <p className="font-display text-2xl font-extrabold tracking-tight text-mist">
          Ready to send?
        </p>
        <p className="mt-2 text-dim">
          Next: review the marketing strategy FullSend built, then turn it on.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            onClick={() => router.push('/app/strategy')}
            className="btn-send text-base"
          >
            SEE THE STRATEGY →
          </button>
          <Link href="/app" className="btn-ghost text-base">
            Go to the Send Center
          </Link>
        </div>
        <p className="mt-4 font-mono text-[11px] text-dimmer">
          Project id: {projectId}
        </p>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="mb-3 flex items-baseline gap-2">
        <span className="label">{title}</span>
        <span className="font-mono text-[10px] text-orange">{count}</span>
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="mt-0.5 font-display text-sm font-bold tracking-tight text-mist">{value}</dd>
    </div>
  );
}

function Capability({
  ok,
  label,
  fallback,
}: {
  ok: boolean;
  label: string;
  fallback?: string;
}) {
  return (
    <li className="flex items-start gap-2.5 text-sm">
      <span className={ok ? 'font-mono text-xs text-live' : 'font-mono text-xs text-warn'}>
        {ok ? '✓' : '!'}
      </span>
      <span className={ok ? 'text-dim' : 'text-dimmer'}>
        {label}
        {!ok && fallback && <span className="block text-xs text-dimmer">{fallback}</span>}
      </span>
    </li>
  );
}

function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
