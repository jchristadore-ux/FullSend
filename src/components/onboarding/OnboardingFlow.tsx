'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Capabilities } from '@/lib/env';
import type { AppScreen, ProductAnalysis, Repository } from '@/lib/types';
import { failureRemedy } from '@/lib/jobs/failure-remedy';

/**
 * "What's your app?" → "FullSend is looking under the hood…" → "We've got it."
 *
 * The progress steps are driven by the real job state on the server, not a
 * timer: a step only ticks over when that work has genuinely happened.
 */

/**
 * The stages, named once.
 *
 * This screen used to keep its own list of labels and map them onto whatever
 * jobs happened to be running. That is how "Understanding the product" was
 * still on screen, and still failing, after the pipeline behind it had been
 * rebuilt: two descriptions of the same machine, one of them stale. The labels
 * now come from the pipeline itself, so there is exactly one answer to what
 * FullSend is doing.
 */
const STAGE_ORDER = ['analysis', 'marketing_plan', 'content', 'schedule'] as const;

interface PipelineStage {
  name: string;
  label: string;
  status: 'complete' | 'in_progress' | 'failed' | 'waiting' | 'not_started';
  detail: string | null;
  error: string | null;
}

interface Pipeline {
  status: string;
  stages: PipelineStage[];
  failedStage: string | null;
}

type Phase = 'input' | 'working' | 'done' | 'error';

interface AnalyzeState {
  status: string;
  repository: Repository | null;
  analysis: ProductAnalysis | null;
  screenshots: { withImages: number; describedOnly: number; note: string } | null;
}

/**
 * How long a stage may sit without moving before it is called stuck.
 *
 * A spinner that never resolves is the worst of the available answers: nothing
 * to read and nothing to press. Saying so turns it back into a screen with a
 * button on it.
 */
const STALL_MS = 3 * 60 * 1000;

export function OnboardingFlow({ capabilities }: { capabilities: Capabilities }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('input');
  const [repo, setRepo] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [state, setState] = useState<AnalyzeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remedy, setRemedy] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set when polling starts, not at render: reading the clock during render is
  // impure, and the value is meaningless until there is a run to time.
  const movedAtRef = useRef(0);
  const lastStepRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const poll = useCallback(
    async (id: string) => {
      try {
        // The queue is drained by cron in production; nudge it here so
        // onboarding is not waiting on the next scheduled tick.
        await fetch(`/api/projects/${id}/tick`, { method: 'POST' }).catch(() => {});

        const [pipeRes, stateRes] = await Promise.all([
          fetch(`/api/projects/${id}/pipeline`, { cache: 'no-store' }),
          fetch(`/api/projects/${id}/analyze`, { cache: 'no-store' }),
        ]);
        const pipe: Pipeline = await pipeRes.json();
        const json: AnalyzeState = await stateRes.json();
        if (!pipeRes.ok) throw new Error((pipe as never as { message: string }).message);

        setState(json);
        setPipeline(pipe);

        const reached = pipe.stages.filter((st) => st.status === 'complete').length;
        if (reached > lastStepRef.current) {
          lastStepRef.current = reached;
          movedAtRef.current = Date.now();
        }

        // The stage that failed says so itself, with the provider's own words.
        // Nothing is lost: everything before it is saved, and the retry starts
        // from the stage that stopped rather than the beginning.
        const failed = pipe.stages.find((st) => st.status === 'failed');
        if (failed) {
          stopPolling();
          setError(`${failed.label} failed: ${failed.error ?? 'no reason given'}`);
          setRemedy(failureRemedy(failed.error ?? ''));
          setPhase('error');
          return;
        }

        if (pipe.stages.every((st) => st.status === 'complete')) {
          stopPolling();
          setPhase('done');
          return;
        }

        if (movedAtRef.current > 0 && Date.now() - movedAtRef.current > STALL_MS) {
          stopPolling();
          const stuck = pipe.stages.find((st) => st.status !== 'complete');
          setError(`FullSend got stuck on "${stuck?.label ?? 'the pipeline'}".`);
          setRemedy(
            'Nothing was lost — every stage that finished is saved. Press Analyze again and ' +
              'it picks up from the stage that stopped rather than starting over.',
          );
          setPhase('error');
        }
      } catch (e) {
        stopPolling();
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    },
    [stopPolling],
  );

  async function analyze(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRemedy(null);
    setPhase('working');
    setPipeline(null);
    lastStepRef.current = 0;
    movedAtRef.current = Date.now();

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
          {(pipeline?.stages ?? STAGE_ORDER.map((name) => ({
            name,
            label: '',
            status: 'waiting' as const,
            detail: null,
            error: null,
          }))).map((st) => {
            const done = st.status === 'complete';
            const active = st.status === 'in_progress';
            return (
              <li
                key={st.name}
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
                  {st.label || '…'}
                </span>
                {st.detail && (
                  <span className="ml-auto truncate font-mono text-[11px] text-dimmer">
                    {st.detail}
                  </span>
                )}
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
