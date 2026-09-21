import { describe, expect, it } from 'vitest';
import { publishDrift } from '@/lib/publish-drift';

describe('publishDrift', () => {
  it('returns null when either timestamp is missing', () => {
    expect(publishDrift(null, '2026-09-20T12:00:00.000Z')).toBeNull();
    expect(publishDrift('2026-09-20T12:00:00.000Z', null)).toBeNull();
  });

  it('labels a late publish without inventing numbers', () => {
    const drift = publishDrift('2026-09-20T12:00:00.000Z', '2026-09-20T13:30:00.000Z');
    expect(drift).not.toBeNull();
    expect(drift!.lateMs).toBe(90 * 60_000);
    expect(drift!.label).toBe('2h late');
  });

  it('labels on-time when within 30 seconds', () => {
    const drift = publishDrift('2026-09-20T12:00:00.000Z', '2026-09-20T12:00:10.000Z');
    expect(drift!.label).toBe('on time');
  });
});
