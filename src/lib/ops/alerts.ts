/**
 * Operator alerting signals derived from the job queue.
 *
 * The worker is durable but unwatched. These signals answer two questions that
 * used to require reading the database by hand:
 *
 *   1. Are the same jobs failing over and over (repeated failure)?
 *   2. Are claimed leases sitting past the lock timeout (stale leases)?
 *
 * Counts and types only — no payloads, no error text that might carry a
 * credential. Surfaced on authorised /api/health and the Control Room.
 */
import 'server-only';
import { systemScope } from '../db';
import { db } from '../db/repo';
import { STALE_LOCK_MS } from '../jobs/job-failure';
import { failureFingerprint } from './redact';
import type { Job, JobType } from '../types';

export type AlertSeverity = 'info' | 'warn' | 'critical';

export interface OpsAlert {
  code: 'repeated_job_failure' | 'stale_leases' | 'dead_letter_backlog';
  severity: AlertSeverity;
  message: string;
  count: number;
  /** Job types involved, when relevant. */
  types?: JobType[];
}

export interface DeadLetterJob {
  id: string;
  type: JobType;
  projectId: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface StaleLease {
  id: string;
  type: JobType;
  projectId: string | null;
  lockedAt: string;
  ageSeconds: number;
}

/** How many recent failures of the same fingerprint count as "repeated". */
export const REPEATED_FAILURE_THRESHOLD = 3;

/** Look-back window for grouping repeated failures. */
export const REPEATED_FAILURE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Dead jobs above this count raise a backlog alert. */
export const DEAD_LETTER_BACKLOG_WARN = 1;

/**
 * Compute current operator alerts from the job table.
 *
 * Never throws for probe use — a missing table becomes an empty report.
 */
export async function computeOpsAlerts(now = Date.now()): Promise<{
  alerts: OpsAlert[];
  staleLeases: StaleLease[];
  deadLetters: DeadLetterJob[];
}> {
  const scope = systemScope('ops alerts');
  let jobs: Job[] = [];
  try {
    jobs = await db().find(scope, 'jobs', {
      orderBy: 'updated_at',
      direction: 'desc',
      limit: 500,
    });
  } catch {
    return { alerts: [], staleLeases: [], deadLetters: [] };
  }

  const staleLeases: StaleLease[] = [];
  const deadLetters: DeadLetterJob[] = [];
  const fingerprints = new Map<
    string,
    { count: number; type: JobType; sample: string }
  >();

  for (const job of jobs) {
    if (job.status === 'running' && job.locked_at) {
      const locked = Date.parse(job.locked_at);
      if (Number.isFinite(locked) && now - locked > STALE_LOCK_MS) {
        staleLeases.push({
          id: job.id,
          type: job.type,
          projectId: job.project_id,
          lockedAt: job.locked_at,
          ageSeconds: Math.round((now - locked) / 1000),
        });
      }
    }

    if (job.status === 'dead') {
      deadLetters.push({
        id: job.id,
        type: job.type,
        projectId: job.project_id,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        // Redacted at display time; keep raw for admin who already sees DB.
        lastError: job.last_error,
        updatedAt: job.updated_at,
        createdAt: job.created_at,
      });
    }

    // Queued-with-error or dead inside the window = a failure that already
    // happened. Group by fingerprint so the same bug hourly is one alert.
    const failedRecently =
      (job.status === 'dead' ||
        (job.status === 'queued' && Boolean(job.last_error) && job.attempts > 0)) &&
      Date.parse(job.updated_at) >= now - REPEATED_FAILURE_WINDOW_MS;

    if (failedRecently && job.last_error) {
      const fp = failureFingerprint(job.type, job.last_error);
      const cur = fingerprints.get(fp);
      if (cur) cur.count += 1;
      else fingerprints.set(fp, { count: 1, type: job.type, sample: fp });
    }
  }

  const alerts: OpsAlert[] = [];

  if (staleLeases.length > 0) {
    alerts.push({
      code: 'stale_leases',
      severity: staleLeases.length >= 3 ? 'critical' : 'warn',
      message: `${staleLeases.length} job lease${staleLeases.length === 1 ? '' : 's'} past the ${Math.round(STALE_LOCK_MS / 60_000)}-minute lock timeout — a worker likely died mid-run.`,
      count: staleLeases.length,
      types: [...new Set(staleLeases.map((s) => s.type))],
    });
  }

  const repeated = [...fingerprints.values()].filter(
    (f) => f.count >= REPEATED_FAILURE_THRESHOLD,
  );
  if (repeated.length > 0) {
    const total = repeated.reduce((n, f) => n + f.count, 0);
    const types = [...new Set(repeated.map((f) => f.type))];
    alerts.push({
      code: 'repeated_job_failure',
      severity: total >= 10 ? 'critical' : 'warn',
      message: `${repeated.length} distinct failure pattern${repeated.length === 1 ? '' : 's'} repeated ≥${REPEATED_FAILURE_THRESHOLD} times in the last ${REPEATED_FAILURE_WINDOW_MS / 3_600_000}h (${total} occurrences). Types: ${types.join(', ')}.`,
      count: total,
      types,
    });
  }

  if (deadLetters.length >= DEAD_LETTER_BACKLOG_WARN) {
    alerts.push({
      code: 'dead_letter_backlog',
      severity: deadLetters.length >= 10 ? 'critical' : 'warn',
      message: `${deadLetters.length} dead-letter job${deadLetters.length === 1 ? '' : 's'} (retries exhausted). Open the Control Room dead-letter view.`,
      count: deadLetters.length,
      types: [...new Set(deadLetters.map((d) => d.type))],
    });
  }

  return {
    alerts,
    staleLeases,
    // Newest first; admin shows a bounded list.
    deadLetters: deadLetters
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 40),
  };
}
