/**
 * Telling somebody a job gave up.
 *
 * A dead job records itself in the database, which is honest but passive: the
 * only way to learn about it is to open the Control Room and look. Nobody
 * opens the Control Room when things appear to be working, so a job that died
 * on Tuesday is discovered on Friday by noticing that nothing has posted.
 *
 * So a dead job files a GitHub issue. That is a place a person already
 * watches, it arrives as a notification, and it carries the error and the
 * remedy the job already worked out. It is also somewhere an agent can read
 * without access to this deployment.
 *
 * Three things this is careful about:
 *
 *   • Secrets. Error text is the most likely place for a credential to escape,
 *     and an issue cannot be un-published. Everything is redacted first.
 *   • Repetition. The same bug failing hourly must not file the same issue
 *     hourly, so a recurrence comments on the open one instead.
 *   • Being optional. With no repository configured this does nothing at all,
 *     and a failure to report never turns a job failure into two failures.
 */
import 'server-only';
import { env } from '../env';
import { logger } from '../logger';
import { failureFingerprint, redact } from './redact';
import type { Job } from '../types';

const log = logger('report-failure');

/** Applied to every issue, so a watcher can find them without guessing. */
export const FAILURE_LABEL = 'fullsend-failure';

const API = 'https://api.github.com';
const TIMEOUT_MS = 8000;

interface ReportInput {
  job: Job;
  message: string;
  remedy: string | null;
}

function configured(): { repo: string; token: string } | null {
  const repo = env.ops.issueRepo;
  const token = env.github.token;
  if (!repo || !token) return null;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    log.warn('FULLSEND_ISSUE_REPO is not owner/repo', { repo });
    return null;
  }
  return { repo, token };
}

async function gh<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: T | null }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => null)) as T | null;
  return { ok: res.ok, status: res.status, body };
}

function issueBody(input: ReportInput, fingerprint: string): string {
  const { job, message, remedy } = input;
  return [
    `A background job gave up after ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}.`,
    '',
    '| | |',
    '| --- | --- |',
    `| Job | \`${job.type}\` |`,
    `| Job id | \`${job.id}\` |`,
    `| Project | \`${job.project_id ?? 'none'}\` |`,
    `| Attempts | ${job.attempts} of ${job.max_attempts} |`,
    `| First seen | ${job.created_at} |`,
    '',
    '**Error**',
    '',
    '```',
    redact(message),
    '```',
    '',
    ...(remedy ? ['**What FullSend suggests**', '', redact(remedy, 800), ''] : []),
    '---',
    `<!-- fullsend-fingerprint: ${fingerprint} -->`,
    '_Filed automatically by FullSend when the job exhausted its retries._',
  ].join('\n');
}

/**
 * Files or updates the issue for a dead job.
 *
 * Never throws: reporting a failure must not itself become a failure, and the
 * database record is already written by the time this runs, so losing the
 * issue loses nothing that was not already saved.
 */
export async function reportJobFailure(input: ReportInput): Promise<{ filed: boolean; url?: string }> {
  const config = configured();
  if (!config) return { filed: false };

  const { repo, token } = config;
  const fingerprint = failureFingerprint(input.job.type, input.message);
  const title = `${input.job.type} is failing (${fingerprint})`;

  try {
    /*
     * Search by the fingerprint in the title rather than by body content:
     * GitHub's code search indexes issue bodies on a delay long enough that a
     * job failing every few minutes would file several issues before the first
     * became findable.
     */
    const existing = await gh<{ items: { number: number; html_url: string }[] }>(
      token,
      `/search/issues?q=${encodeURIComponent(
        `repo:${repo} is:issue is:open in:title "${fingerprint}"`,
      )}`,
    );

    const open = existing.body?.items?.[0];
    if (open) {
      await gh(token, `/repos/${repo}/issues/${open.number}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          body: `Happened again at ${new Date().toISOString()} — job \`${input.job.id}\`.`,
        }),
      });
      log.info('failure recurrence noted', { issue: open.number, type: input.job.type });
      return { filed: false, url: open.html_url };
    }

    const created = await gh<{ number: number; html_url: string }>(
      token,
      `/repos/${repo}/issues`,
      {
        method: 'POST',
        body: JSON.stringify({
          title,
          body: issueBody(input, fingerprint),
          labels: [FAILURE_LABEL],
        }),
      },
    );

    if (!created.ok) {
      log.warn('could not file failure issue', { status: created.status, repo });
      return { filed: false };
    }

    log.info('failure issue filed', { issue: created.body?.number, type: input.job.type });
    return { filed: true, url: created.body?.html_url };
  } catch (e) {
    log.warn('failure reporting failed', { error: e instanceof Error ? e.message : String(e) });
    return { filed: false };
  }
}
