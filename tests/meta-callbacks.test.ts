/**
 * Meta's deauthorize and data-deletion callbacks.
 *
 * These are public, unauthenticated endpoints that disconnect accounts. The
 * only thing standing between them and a stranger revoking someone's Instagram
 * by guessing a user id is the signed_request check, so that is what gets
 * pinned hardest here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { parseSignedRequest } from '@/lib/social/signed-request';
import { revokeInstagramFor } from '@/lib/social/meta-callbacks';
import { connectPlatform, createProject, setupContext, teardown, type TestContext } from './helpers';
import { db } from '@/lib/db/repo';
import { systemScope } from '@/lib/db';
import type { Project } from '@/lib/types';

const SECRET = 'app-secret';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload: object, secret = SECRET): string {
  const encoded = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest();
  return `${b64url(sig)}.${encoded}`;
}

describe('signed_request', () => {
  it('accepts one Meta signed', () => {
    const parsed = parseSignedRequest(sign({ user_id: '17841400000', algorithm: 'HMAC-SHA256' }), SECRET);
    expect(parsed?.user_id).toBe('17841400000');
  });

  it('refuses one signed with a different secret', () => {
    // The whole point: anyone can POST here, only Meta can sign.
    expect(parseSignedRequest(sign({ user_id: '1' }, 'not-the-secret'), SECRET)).toBeNull();
  });

  it('refuses a payload edited after signing', () => {
    const original = sign({ user_id: '111', algorithm: 'HMAC-SHA256' });
    const [sig] = original.split('.');
    const tampered = `${sig}.${b64url(JSON.stringify({ user_id: '222' }))}`;

    expect(parseSignedRequest(tampered, SECRET)).toBeNull();
  });

  it('refuses an unsigned payload with no signature at all', () => {
    expect(parseSignedRequest(b64url(JSON.stringify({ user_id: '1' })), SECRET)).toBeNull();
  });

  it('refuses an algorithm this code has not been reviewed against', () => {
    const encoded = b64url(JSON.stringify({ user_id: '1', algorithm: 'none' }));
    const sig = crypto.createHmac('sha256', SECRET).update(encoded).digest();
    expect(parseSignedRequest(`${b64url(sig)}.${encoded}`, SECRET)).toBeNull();
  });

  it('refuses malformed input rather than throwing', () => {
    // A length mismatch makes timingSafeEqual throw; that must not escape.
    for (const bad of ['', '.', 'a.b', 'not-base64!.also-not', 'x.'.repeat(50)]) {
      expect(() => parseSignedRequest(bad, SECRET)).not.toThrow();
      expect(parseSignedRequest(bad, SECRET)).toBeNull();
    }
  });
});

describe('revoking on Meta\'s instruction', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
  });
  afterEach(() => teardown());

  it('destroys the token and marks the account revoked', async () => {
    await connectPlatform(ctx.scope, project, 'instagram');
    const sys = systemScope('test');
    const [account] = await db().find(sys, 'social_accounts', { where: { project_id: project.id } });

    const result = await revokeInstagramFor(account.external_id);

    expect(result).toEqual({ accounts: 1, tokens: 1 });
    expect(await db().find(sys, 'oauth_tokens', { where: { project_id: project.id } })).toHaveLength(0);
    const [after] = await db().find(sys, 'social_accounts', { where: { project_id: project.id } });
    expect(after.status).toBe('revoked');
  });

  it('touches nothing when the id belongs to no account here', async () => {
    await connectPlatform(ctx.scope, project, 'instagram');
    const sys = systemScope('test');

    expect(await revokeInstagramFor('some-other-instagram-user')).toEqual({ accounts: 0, tokens: 0 });
    expect(await db().find(sys, 'oauth_tokens', { where: { project_id: project.id } })).toHaveLength(1);
  });
});
