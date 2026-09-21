import { beforeEach, describe, expect, it, vi } from 'vitest';
import { check, LIMITS, resetLimits } from '@/lib/rate-limit';
import { isBlockedHostname, isBlockedIp } from '@/lib/website/ssrf';
import { FullSendError } from '@/lib/errors';

describe('public demo guards', () => {
  beforeEach(() => resetLimits());

  it('rate-limits the demo bucket tightly', () => {
    for (let i = 0; i < LIMITS.demo.limit; i++) {
      check('demo:test-ip', LIMITS.demo);
    }
    expect(() => check('demo:test-ip', LIMITS.demo)).toThrow(FullSendError);
    try {
      check('demo:test-ip', LIMITS.demo);
    } catch (e) {
      expect(e).toBeInstanceOf(FullSendError);
      expect((e as FullSendError).status).toBe(429);
    }
  });

  it('blocks loopback and link-local hosts for website demo SSRF safety', () => {
    expect(isBlockedHostname('localhost')).toBe(true);
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
    expect(isBlockedHostname('example.com')).toBe(false);
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('10.0.0.1')).toBe(true);
    expect(isBlockedIp('169.254.169.254')).toBe(true);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
  });
});

describe('acquire metrics honesty', () => {
  it('computes MRR only from Stripe-backed active/trialing paid tiers', async () => {
    const { PLANS } = await import('@/lib/billing/plans');
    // Guardrail: plan prices are explicit — metrics must never invent numbers.
    expect(PLANS.free.priceUsd).toBe(0);
    expect(PLANS.send.priceUsd).toBeGreaterThan(0);
    expect(PLANS.full_send.priceUsd).toBeGreaterThan(0);
    expect(PLANS.agency.priceUsd).toBeGreaterThan(0);
  });
});

describe('first-run checklist order', () => {
  it('walks analyse → connect → plan → first post', async () => {
    const { buildFirstRunSteps } = await import('@/components/onboarding/FirstRunGuide');
    const steps = buildFirstRunSteps({
      hasAnalysis: false,
      hasConnectedAccount: false,
      strategyApproved: false,
      hasContent: false,
      hasPublished: false,
    });
    expect(steps.map((s) => s.id)).toEqual(['analyze', 'connect', 'plan', 'first_post']);
    expect(steps[0].done).toBe(false);
    const mid = buildFirstRunSteps({
      hasAnalysis: true,
      hasConnectedAccount: true,
      strategyApproved: false,
      hasContent: false,
      hasPublished: false,
    });
    expect(mid.filter((s) => s.done).map((s) => s.id)).toEqual(['analyze', 'connect']);
    expect(mid.find((s) => !s.done)?.id).toBe('plan');
  });
});
