/**
 * Meta readiness health — presence flags only, never secrets.
 */
import { describe, expect, it } from 'vitest';
import { metaReadiness } from '@/lib/social/meta-readiness';
import {
  INSTAGRAM_SCOPES_FACEBOOK_LOGIN,
  INSTAGRAM_SCOPES_INSTAGRAM_LOGIN,
} from '@/lib/social/instagram-scopes';

describe('metaReadiness', () => {
  it('never returns secret-looking fields', () => {
    const meta = metaReadiness();
    expect(meta).not.toHaveProperty('appId');
    expect(meta).not.toHaveProperty('appSecret');
    expect(meta).not.toHaveProperty('webhookVerifyToken');
    expect(Object.keys(meta).sort()).toEqual(
      [
        'appIdPresent',
        'appSecretPresent',
        'callbacks',
        'configured',
        'contactEmailPresent',
        'encryptionKeyPresent',
        'graphVersion',
        'legalPages',
        'loginMode',
        'media',
        'redirectUri',
        'reviewNotes',
        'scopes',
      ].sort(),
    );
    expect(typeof meta.appIdPresent).toBe('boolean');
    expect(typeof meta.appSecretPresent).toBe('boolean');
  });

  it('exposes the redirect and compliance callback URLs derived from appUrl', () => {
    const meta = metaReadiness();
    expect(meta.redirectUri).toMatch(/\/api\/accounts\/instagram\/callback$/);
    expect(meta.callbacks.deauthorize).toMatch(/\/api\/accounts\/instagram\/deauthorize$/);
    expect(meta.callbacks.dataDeletion).toMatch(/\/api\/accounts\/instagram\/data-deletion$/);
    expect(meta.legalPages.privacy).toMatch(/\/privacy$/);
    expect(meta.legalPages.terms).toMatch(/\/terms$/);
    expect(meta.legalPages.dataDeletion).toMatch(/\/data-deletion$/);
  });

  it('lists the scopes for the active login mode', () => {
    const meta = metaReadiness();
    const expected =
      meta.loginMode === 'instagram_login'
        ? INSTAGRAM_SCOPES_INSTAGRAM_LOGIN
        : INSTAGRAM_SCOPES_FACEBOOK_LOGIN;
    expect(meta.scopes).toEqual([...expected]);
  });

  it('notes that media must be a public HTTPS URL', () => {
    const meta = metaReadiness();
    expect(meta.media.requiresPublicHttpsUrl).toBe(true);
    expect(meta.media.note.toLowerCase()).toContain('public');
  });
});
