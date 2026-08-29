'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * THE PIPELINE.
 *
 * Four checkpoints, each with the thing it produced. A stage that is complete
 * says so and stays that way; a stage that failed offers to run again on its
 * own, without touching anything before it. That distinction is the whole
 * point: the failure of one step is not a reason to pay for the ones that
 * already worked.
 */

interface Stage {
  name: 'analysis' | 'marketing_plan' | 'content' | 'schedule';
  label: string;
  status: 'complete' | 'in_progress' | 'failed' | 'waiting' | 'not_started';
  detail: string | null;
  error: string | null;
  retryable: boolean;
}

interface State {
  status: string;
  stages: Stage[];
  currentStage: string | null;
  failedStage: string | null;
}

const MARK: Record<Stage['status'], string> = {
  complete: '✓',
  in_progress: '⟳',
  failed: '✕',
  waiting: '○',
  not_started: '○',
};

const TONE: Record<Stage['status'], string> = {
  complete: 'text-live',
  in_progress: 'text-send',
  failed: 'text-warn',
  waiting: 'text-dimmer',
  not_started: 'text-dimmer',
};

const WORD: Record<Stage['status'], string> = {
  complete: 'Complete',
  in_progress: 'Working',
  failed: 'Failed',
  waiting: 'Waiting',
  not_started: 'Not started',
};

export function PipelineCard({ projectId }: { projectId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/pipeline`, { cache: 'no-store' });
      const json = await res.json();
      if (res.ok) setState(json);
    } catch {
      // A failed poll is not worth a banner; the next one will tell the story.
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    timer.current = setInterval(load, 5000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  async function retry(stage: string) {
    setBusy(stage);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/pipeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.remedy ?? json.message ?? 'Could not start that step');
      if (json.state) setState(json.state);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!state) return null;

  return (
    <section className="mt-8 border border-edge">
      <div className="flex items-center justify-between border-b border-edge px-4 py-3">
        <span className="font-mono text-[10px] uppercase tracking-widest text-dimmer">
          Pipeline
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-dimmer">
          {state.status.replace(/_/g, ' ')}
        </span>
      </div>

      <ul>
        {state.stages.map((stage) => (
          <li
            key={stage.name}
            className="flex items-center justify-between gap-4 border-b border-edge px-4 py-3 last:border-b-0"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`font-mono text-sm ${TONE[stage.status]}`}>
                  {MARK[stage.status]}
                </span>
                <span className="font-display text-sm font-extrabold tracking-tight text-mist">
                  {stage.label}
                </span>
                <span className={`font-mono text-[10px] uppercase tracking-widest ${TONE[stage.status]}`}>
                  {WORD[stage.status]}
                </span>
              </div>
              {(stage.detail || stage.error) && (
                <p className="mt-1 truncate text-xs text-dimmer">{stage.error ?? stage.detail}</p>
              )}
            </div>

            {stage.retryable && (
              <button
                type="button"
                onClick={() => retry(stage.name)}
                disabled={busy === stage.name}
                className="btn-quiet shrink-0"
              >
                {busy === stage.name ? 'Starting…' : stage.status === 'failed' ? 'Retry' : 'Start'}
              </button>
            )}
          </li>
        ))}
      </ul>

      {error && <p className="border-t border-edge px-4 py-3 text-xs text-warn">{error}</p>}
    </section>
  );
}
