/**
 * Workstream 5 — reliability & observability.
 *
 * Zero-config error feed, optional Sentry upgrade flag, operator alerts,
 * per-tenant AI rate limits, and customer-visible publish retry status.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureError,
  clearCapturedErrors,
  recentErrors,
  sentryConfigured,
} from '@/lib/ops/error-tracking';
import {
  computeOpsAlerts,
  REPEATED_FAILURE_THRESHOLD,
} from '@/lib/ops/alerts';
import { STALE_LOCK_MS } from '@/lib/jobs/job-failure';
import {
  assertTenantAiAllowance,
  tenantAiKey,
  tenantAiRule,
} from '@/lib/ai/tenant-limit';
import { resetLimits } from '@/lib/rate-limit';
import { publishDisplayStatus } from '@/components/app/status';
import { setupContext, teardown } from './helpers';
import { db } from '@/lib/db/repo';
import { systemScope } from '@/lib/db';
import { newId, nowIso } from '@/lib/ids';
import { FullSendError } from '@/lib/errors';
import type { Job } from '@/lib/types';

describe('error tracking (zero-config + Sentry upgrade)', () => {
  beforeEach(() => {
    clearCapturedErrors();
    delete process.env.SENTRY_DSN;
  });

  it('records into the ring buffer with no Sentry configured', async () => {
    expect(sentryConfigured()).toBe(false);
    const entry = await captureError('Instagram rejected the media', {
      scope: 'publish:instagram',
      meta: { access_token: 'EAAshouldredact' },
    });
    expect(entry.sentry).toBe('disabled');
    expect(recentErrors()).toHaveLength(1);
    expect(recentErrors()[0].message).toContain('Instagram rejected');
    expect(JSON.stringify(recentErrors()[0].meta)).not.toContain('EAAshouldredact');
  });

  it('redacts secrets before storing', async () => {
    await captureError(
      'failed postgresql://postgres.abcd:hunter2@aws-0.pooler.supabase.com:5432/postgres',
      { scope: 'db' },
    );
    expect(recentErrors()[0].message).not.toContain('hunter2');
    expect(recentErrors()[0].message).toContain('[connection-string]');
  });

  it('reports sentryConfigured when SENTRY_DSN is set', () => {
    process.env.SENTRY_DSN = 'https://publickey@o0.ingest.sentry.io/123';
    expect(sentryConfigured()).toBe(true);
  });
});

describe('publish display status', () => {
  it('keeps a clean schedule looking scheduled', () => {
    expect(publishDisplayStatus({ status: 'scheduled', attempts: 0, lastError: null })).toBe(
      'scheduled',
    );
  });

  it('surfaces retrying when a scheduled post already failed once', () => {
    expect(
      publishDisplayStatus({
        status: 'scheduled',
        attempts: 2,
        lastError: 'timeout talking to Instagram',
      }),
    ).toBe('retrying');
  });

  it('leaves failed / published alone', () => {
    expect(publishDisplayStatus({ status: 'failed', attempts: 5, lastError: 'x' })).toBe('failed');
    expect(publishDisplayStatus({ status: 'published', attempts: 1, lastError: null })).toBe(
      'published',
    );
  });
});

describe('per-tenant AI rate limiting', () => {
  beforeEach(() => resetLimits());

  it('keys by user when present', () => {
    expect(tenantAiKey({ userId: 'u1', projectId: 'p1' })).toBe('ai:user:u1');
    expect(tenantAiKey({ userId: null, projectId: 'p1' })).toBe('ai:project:p1');
    expect(tenantAiKey({ userId: null, projectId: null })).toBeNull();
  });

  it('allows traffic under the hourly ceiling', () => {
    const rule = tenantAiRule();
    for (let i = 0; i < rule.limit; i++) {
      assertTenantAiAllowance({ userId: 'user-a', projectId: 'proj-a' });
    }
  });

  it('blocks one tenant without blocking another', () => {
    const rule = tenantAiRule();
    for (let i = 0; i < rule.limit; i++) {
      assertTenantAiAllowance({ userId: 'user-hot' });
    }
    expect(() => assertTenantAiAllowance({ userId: 'user-hot' })).toThrow(FullSendError);
    expect(() => assertTenantAiAllowance({ userId: 'user-hot' })).toThrow(/hourly AI generation/);
    // Neighbour still fine.
    expect(() => assertTenantAiAllowance({ userId: 'user-cold' })).not.toThrow();
  });
});

describe('ops alerts: stale leases and repeated failures', () => {
  beforeEach(async () => {
    await setupContext();
  });
  afterEach(() => teardown());

  async function insertJob(partial: Partial<Job> & Pick<Job, 'type' | 'status'>): Promise<Job> {
    const now = nowIso();
    return db().insert(systemScope('test'), 'jobs', {
      id: newId(),
      project_id: null,
      payload: {},
      attempts: partial.attempts ?? 0,
      max_attempts: partial.max_attempts ?? 5,
      run_after: now,
      locked_at: partial.locked_at ?? null,
      last_error: partial.last_error ?? null,
      result: null,
      created_at: now,
      updated_at: now,
      ...partial,
    });
  }

  it('flags leases older than the lock timeout', async () => {
    const lockedAt = new Date(Date.now() - STALE_LOCK_MS - 5_000).toISOString();
    await insertJob({
      type: 'publish_post',
      status: 'running',
      locked_at: lockedAt,
      attempts: 1,
    });
    const { alerts, staleLeases } = await computeOpsAlerts();
    expect(staleLeases.length).toBe(1);
    expect(alerts.some((a) => a.code === 'stale_leases')).toBe(true);
  });

  it('flags repeated failures of the same fingerprint', async () => {
    for (let i = 0; i < REPEATED_FAILURE_THRESHOLD; i++) {
      await insertJob({
        type: 'generate_content',
        status: 'dead',
        attempts: 5,
        last_error: 'AI returned unusable output: value_proposition required',
      });
    }
    const { alerts, deadLetters } = await computeOpsAlerts();
    expect(deadLetters.length).toBeGreaterThanOrEqual(REPEATED_FAILURE_THRESHOLD);
    expect(alerts.some((a) => a.code === 'repeated_job_failure')).toBe(true);
    expect(alerts.some((a) => a.code === 'dead_letter_backlog')).toBe(true);
  });
});
