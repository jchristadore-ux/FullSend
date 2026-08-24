'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Recommendation } from '@/lib/types';

/**
 * FULLSEND'S NEXT MOVE.
 *
 * FullSend states what it is doing. "DO IT" is the primary action and the
 * default; "CHANGE IT" is the escape hatch. When the machine already acted
 * under Full Send, the card reports the decision rather than asking for one.
 */
export function NextMoveCard({
  projectId,
  recommendation,
}: {
  projectId: string;
  recommendation: Recommendation | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'apply' | 'dismiss'>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: 'apply' | 'dismiss') {
    if (!recommendation) return;
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/recommendations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recommendationId: recommendation.id, action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.remedy ?? json.message ?? 'Could not apply that');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!recommendation) {
    return (
      <section className="panel border-l-2 border-l-orange p-5 sm:p-6">
        <span className="label">FullSend&rsquo;s next move</span>
        <p className="mt-3 text-sm text-dim">
          Not enough published data to have an opinion yet. FullSend will keep posting and come
          back with one.
        </p>
      </section>
    );
  }

  const alreadyActed =
    recommendation.status === 'auto_applied' || recommendation.status === 'applied';

  return (
    <section className="panel border-l-2 border-l-orange p-5 sm:p-6">
      <div className="flex items-center justify-between">
        <span className="label">FullSend&rsquo;s next move</span>
        {alreadyActed && (
          <span className="font-mono text-[10px] uppercase tracking-widest text-live">
            {recommendation.status === 'auto_applied' ? 'DONE AUTOMATICALLY' : 'APPLIED'}
          </span>
        )}
      </div>

      <p className="mt-3 font-display text-lg font-bold leading-snug tracking-tight text-mist">
        &ldquo;{recommendation.statement}&rdquo;
      </p>

      {recommendation.rationale && (
        <p className="mt-2.5 text-sm leading-relaxed text-dim">{recommendation.rationale}</p>
      )}

      {recommendation.evidence.length > 0 && (
        <dl className="mt-4 space-y-1.5 border-t border-edge pt-3">
          {recommendation.evidence.map((e) => (
            <div key={e.label} className="flex justify-between gap-3 font-mono text-[11px]">
              <dt className="text-dimmer">{e.label}</dt>
              <dd className="tabular-nums text-mist">{e.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {error && <p className="mt-3 text-xs text-fail">{error}</p>}

      {alreadyActed ? (
        <p className="mt-5 font-mono text-[11px] text-dimmer">
          Applied to your strategy. Next week&rsquo;s content reflects it.
        </p>
      ) : (
        <div className="mt-5 flex gap-2">
          <button
            onClick={() => act('apply')}
            disabled={busy !== null}
            className="btn-send flex-1 !px-4 !py-2.5 text-sm"
          >
            {busy === 'apply' ? 'DOING IT…' : 'DO IT'}
          </button>
          <button
            onClick={() => act('dismiss')}
            disabled={busy !== null}
            className="btn-ghost !px-4 !py-2.5 text-sm"
          >
            {busy === 'dismiss' ? '…' : 'CHANGE IT'}
          </button>
        </div>
      )}

      <p className="mt-3 font-mono text-[10px] text-dimmer">
        Confidence {Math.round(recommendation.confidence * 100)}%
      </p>
    </section>
  );
}
