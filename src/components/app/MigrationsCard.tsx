'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The database schema, and the button that fixes it.
 *
 * Applying a migration used to mean opening Supabase, finding the right file
 * in the repository, and pasting it into a SQL editor — a step nobody can do
 * on your behalf, and one whose being skipped is invisible until something
 * breaks for an unrelated-looking reason. This says plainly which migrations
 * this database is missing, and runs them.
 */

interface MigrationState {
  name: string;
  applied: boolean;
  appliedAt: string | null;
  changedSinceApplied: boolean;
}

interface Report {
  connected: boolean;
  reason?: string;
  migrations: MigrationState[];
  pending: string[];
  changed: string[];
}

export function MigrationsCard() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/migrations', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.remedy ?? json.message ?? 'Could not read the schema state');
      setReport(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: 'apply' | 'baseline') {
    setBusy(action);
    setError(null);
    setNote(null);
    try {
      const res = await fetch('/api/admin/migrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.remedy ?? json.message ?? 'That did not work');

      if (json.report) setReport(json.report);

      if (action === 'baseline') {
        setNote(
          json.recorded?.length
            ? `Recorded ${json.recorded.length} migration(s) as already applied.`
            : 'Nothing to record — every migration was already in the ledger.',
        );
      } else if (json.failed) {
        setError(`${json.failed.name} failed: ${json.failed.error}`);
      } else {
        setNote(
          json.applied?.length
            ? `Applied ${json.applied.join(', ')}.`
            : 'Nothing to apply — the database is up to date.',
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!report) return null;

  const pending = report.pending.length;

  return (
    <section className="panel mt-6 p-5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="label">Database schema</span>
        <span
          className={`font-mono text-[10px] uppercase tracking-widest ${
            !report.connected ? 'text-warn' : pending ? 'text-warn' : 'text-live'
          }`}
        >
          {!report.connected
            ? 'Manual'
            : pending
              ? `${pending} pending`
              : 'Up to date'}
        </span>
      </div>

      <ul className="mt-3 divide-y divide-edge border border-edge">
        {report.migrations.map((m) => (
          <li key={m.name} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="truncate font-mono text-[11px] text-mist">{m.name}</span>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest">
              {m.changedSinceApplied ? (
                <span className="text-fail">Changed since applied</span>
              ) : m.applied ? (
                <span className="text-live">Applied</span>
              ) : (
                <span className="text-warn">Pending</span>
              )}
            </span>
          </li>
        ))}
      </ul>

      {!report.connected ? (
        <p className="mt-3 border-t border-edge pt-3 font-mono text-[10px] leading-relaxed text-dimmer">
          {report.reason}
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => run('apply')}
            disabled={busy !== null || pending === 0}
            className="btn-quiet"
          >
            {busy === 'apply' ? 'Applying…' : `Apply ${pending || 'nothing'} pending`}
          </button>
          <button
            type="button"
            onClick={() => run('baseline')}
            disabled={busy !== null || pending === 0}
            className="btn-quiet"
          >
            {busy === 'baseline' ? 'Recording…' : 'Already ran these by hand'}
          </button>
        </div>
      )}

      {report.changed.length > 0 && (
        <p className="mt-3 text-xs text-fail">
          {report.changed.join(', ')} changed after being applied. A migration is a record of what
          was run, so editing one leaves this database and the file permanently out of step — add a
          new migration instead.
        </p>
      )}

      {note && <p className="mt-3 text-xs text-live">{note}</p>}
      {error && <p className="mt-3 whitespace-pre-wrap break-words text-xs text-fail">{error}</p>}
    </section>
  );
}
