/**
 * Who reaches the Control Room.
 *
 * `/admin` is where a founder finds out that jobs are failing rather than
 * merely queued, so being locked out of it turns a diagnosable problem into a
 * mystery. The flag was written once at first sign-in and never revisited,
 * which meant setting FULLSEND_ADMIN_EMAILS afterwards did nothing at all —
 * the row already existed, and the setting was read and discarded in silence.
 *
 * This grants and revokes administrative access, so both directions are
 * pinned, including the case where the list is not configured.
 */
import { describe, expect, it } from 'vitest';
import { nextAdminFlag } from '@/lib/auth/session';

describe('admin reconciliation', () => {
  const notAdmin = { email: 'founder@example.com', is_admin: false };

  it('promotes someone added to the list after they signed up', () => {
    expect(nextAdminFlag(notAdmin, ['founder@example.com'])).toBe(true);
  });

  it('matches the address case-insensitively', () => {
    expect(nextAdminFlag({ email: 'Founder@Example.com', is_admin: false }, ['founder@example.com']))
      .toBe(true);
  });

  it('revokes someone taken off the list', () => {
    expect(nextAdminFlag({ email: 'ex@example.com', is_admin: true }, ['founder@example.com']))
      .toBe(false);
  });

  it('writes nothing when the flag already agrees', () => {
    expect(nextAdminFlag({ email: 'founder@example.com', is_admin: true }, ['founder@example.com']))
      .toBeNull();
    expect(nextAdminFlag(notAdmin, ['someone@example.com'])).toBeNull();
  });

  it('leaves everyone alone when the list is not configured', () => {
    // An empty list means "unset", not "nobody" — reading it as "nobody" would
    // revoke a flag an operator had granted directly in SQL.
    expect(nextAdminFlag({ email: 'founder@example.com', is_admin: true }, [])).toBeNull();
    expect(nextAdminFlag(notAdmin, [])).toBeNull();
  });
});
