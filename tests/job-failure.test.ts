/**
 * Telling a slow job from a broken one.
 *
 * The runner requeues a retryable failure rather than marking it failed, so a
 * status check sees `queued` and reports progress — through five attempts and
 * their backoff, on a queue that drains every few minutes at best. This was
 * fixed once on the calendar while the onboarding screen went on spinning on
 * "Reading repository" with the reason sitting unread on the same row. One
 * rule now, so they cannot disagree again.
 */
import { describe, expect, it } from 'vitest';
import { hasFailed, stillRunning } from '@/lib/jobs/job-failure';

describe('hasFailed', () => {
  it('is true for a requeued failure, which still reads as queued', () => {
    expect(hasFailed({ status: 'queued', attempts: 1, error: 'Bad credentials' })).toBe(true);
  });

  it('is true once the attempts run out', () => {
    expect(hasFailed({ status: 'dead', attempts: 5, error: 'Repo not found' })).toBe(true);
  });

  it('is false before the first attempt', () => {
    expect(hasFailed({ status: 'queued', attempts: 0, error: null })).toBe(false);
  });

  it('is false while genuinely running', () => {
    expect(hasFailed({ status: 'running', attempts: 0 })).toBe(false);
  });

  it('is false for a job that succeeded, even carrying an old error', () => {
    // A retry that eventually worked leaves last_error behind on some stores.
    expect(hasFailed({ status: 'succeeded', attempts: 2, error: 'a previous attempt' })).toBe(false);
  });

  it('is false when there is no job yet', () => {
    expect(hasFailed(null)).toBe(false);
    expect(hasFailed(undefined)).toBe(false);
  });

  it('needs a recorded reason, not just an attempt count', () => {
    // Mid-flight: attempts is incremented on claim, before any failure.
    expect(hasFailed({ status: 'running', attempts: 1, error: null })).toBe(false);
  });
});

describe('stillRunning', () => {
  it('is true only while working and unbroken', () => {
    expect(stillRunning({ status: 'running', attempts: 0 })).toBe(true);
    expect(stillRunning({ status: 'queued', attempts: 0 })).toBe(true);
  });

  it('is false once it has failed, however the status reads', () => {
    expect(stillRunning({ status: 'queued', attempts: 1, error: 'boom' })).toBe(false);
  });

  it('is false when it succeeded', () => {
    expect(stillRunning({ status: 'succeeded', attempts: 1 })).toBe(false);
  });
});
