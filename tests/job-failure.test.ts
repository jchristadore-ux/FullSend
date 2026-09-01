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
import { hasFailed, isStalled, isWaitingForWorker, stillRunning } from '@/lib/jobs/job-failure';

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

/*
 * The distinction this file exists to hold: a job nobody has reached is
 * waiting, and a job somebody claimed and abandoned is broken. They were
 * conflated on a six-minute timer, which meant healthy work was reported as
 * failed for as long as the queue took to come round — hours, on the scheduler
 * that actually runs.
 */
describe('waiting versus dead', () => {
  const HOURS_AGO = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  it('does not call a long-queued job stalled, however long it has waited', () => {
    const job = { status: 'queued', attempts: 0, error: null, updatedAt: HOURS_AGO };
    expect(isStalled(job)).toBe(false);
    expect(hasFailed(job)).toBe(false);
    expect(isWaitingForWorker(job)).toBe(true);
  });

  it('still calls a claimed job with an expired lease stalled', () => {
    const job = { status: 'running', attempts: 1, error: null, lockedAt: HOURS_AGO };
    expect(isStalled(job)).toBe(true);
    expect(hasFailed(job)).toBe(true);
    expect(isWaitingForWorker(job)).toBe(false);
  });

  it('does not mistake a job that has already failed for one merely waiting', () => {
    // Requeued with a backoff after a real failure: queued, but not innocent.
    const job = { status: 'queued', attempts: 2, error: 'Anthropic API error', updatedAt: HOURS_AGO };
    expect(isWaitingForWorker(job)).toBe(false);
    expect(hasFailed(job)).toBe(true);
  });

  it('leaves a freshly claimed job alone', () => {
    const job = { status: 'running', attempts: 1, error: null, lockedAt: new Date().toISOString() };
    expect(isStalled(job)).toBe(false);
    expect(hasFailed(job)).toBe(false);
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
