/**
 * Error tracking that works with zero config and upgrades when SENTRY_DSN is set.
 *
 * Without Sentry: every captured error lands in an in-process ring buffer that
 * the Control Room and (authorised) /api/health can read. That is enough to
 * see what is failing on the instance that just failed — which is the common
 * case on a single Vercel deployment.
 *
 * With SENTRY_DSN: the same capture also POSTs a minimal event to Sentry's
 * store endpoint. No SDK dependency — one fetch, redacted message, tags.
 * Reporting never throws: a broken sink must not turn one failure into two.
 */
import { redact } from './redact';

export interface CapturedError {
  id: string;
  ts: string;
  message: string;
  scope: string;
  level: 'error' | 'warning';
  meta?: Record<string, unknown>;
  /** True when a Sentry envelope was accepted (or skipped because unset). */
  sentry: 'sent' | 'skipped' | 'failed' | 'disabled';
}

const RING_MAX = 50;
const ring: CapturedError[] = [];
let seq = 0;

function dsn(): string | undefined {
  const v = process.env.SENTRY_DSN;
  return v && v.trim() ? v.trim() : undefined;
}

/** Whether the optional Sentry upgrade is configured. Never the DSN itself. */
export function sentryConfigured(): boolean {
  return Boolean(dsn());
}

export function recentErrors(limit = 20): CapturedError[] {
  return ring.slice(0, Math.max(1, Math.min(limit, RING_MAX)));
}

export function clearCapturedErrors(): void {
  ring.length = 0;
  seq = 0;
}

/**
 * Record an error for operators, and optionally forward it to Sentry.
 *
 * Safe to call from the logger, the job runner, and publish finals. Secrets in
 * the message are stripped before anything leaves the process.
 */
export async function captureError(
  message: string,
  opts: {
    scope?: string;
    level?: 'error' | 'warning';
    meta?: Record<string, unknown>;
    /** Skip the network hop (tests, or when the caller already reported). */
    localOnly?: boolean;
  } = {},
): Promise<CapturedError> {
  const entry: CapturedError = {
    id: `err_${Date.now().toString(36)}_${(++seq).toString(36)}`,
    ts: new Date().toISOString(),
    message: redact(message, 800),
    scope: opts.scope ?? 'app',
    level: opts.level ?? 'error',
    meta: opts.meta ? scrubMeta(opts.meta) : undefined,
    sentry: 'disabled',
  };

  ring.unshift(entry);
  if (ring.length > RING_MAX) ring.length = RING_MAX;

  if (opts.localOnly || !dsn()) {
    entry.sentry = dsn() ? 'skipped' : 'disabled';
    return entry;
  }

  try {
    const ok = await sendToSentry(entry);
    entry.sentry = ok ? 'sent' : 'failed';
  } catch {
    entry.sentry = 'failed';
  }
  return entry;
}

function scrubMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/token|secret|password|authorization|api[_-]?key|dsn/i.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    if (typeof v === 'string') out[k] = redact(v, 200);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else out[k] = '[object]';
  }
  return out;
}

/**
 * Minimal Sentry store API client.
 *
 * DSN shape: https://<public_key>@<host>/<project_id>
 * Avoids pulling @sentry/node for a single optional sink.
 */
async function sendToSentry(entry: CapturedError): Promise<boolean> {
  const raw = dsn();
  if (!raw) return false;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  const publicKey = url.username;
  const projectId = url.pathname.replace(/^\/+/, '');
  if (!publicKey || !projectId) return false;

  const store = `${url.protocol}//${url.host}/api/${projectId}/store/`;
  const payload = {
    event_id: entry.id.replace(/[^a-f0-9]/gi, '').padEnd(32, '0').slice(0, 32),
    timestamp: entry.ts,
    platform: 'node',
    level: entry.level === 'warning' ? 'warning' : 'error',
    logger: entry.scope,
    message: entry.message,
    tags: {
      scope: entry.scope,
      fullsend: 'true',
    },
    extra: entry.meta ?? {},
  };

  const res = await fetch(store, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': [
        'Sentry sentry_version=7',
        `sentry_key=${publicKey}`,
        'sentry_client=fullsend/0.1',
      ].join(', '),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(4000),
    cache: 'no-store',
  });
  return res.ok || res.status === 200 || res.status === 202;
}
