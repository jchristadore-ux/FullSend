/**
 * What leaves the building when a job dies.
 *
 * A dead job files a GitHub issue, and an issue cannot be un-published — it is
 * indexed, mirrored and mailed out before anyone notices what is in it. Error
 * text is exactly where a credential escapes: a provider echoing the request,
 * a driver naming its connection string, a token in a URL.
 *
 * So the redaction is not a nicety, and these are the tests that hold it.
 */
import { describe, expect, it } from 'vitest';
import { failureFingerprint, redact } from '@/lib/ops/redact';

describe('redacting a failure before it is published', () => {
  it('removes a Postgres connection string, password and all', () => {
    const out = redact(
      'connect ECONNREFUSED postgresql://postgres.abcd:hunter2@aws-0.pooler.supabase.com:5432/postgres',
    );
    expect(out).not.toContain('hunter2');
    expect(out).toContain('[connection-string]');
  });

  it('removes the key shapes each provider issues', () => {
    const secrets = [
      'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
      'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'sk_live_AAAAAAAAAAAAAAAA',
      'EAABBBBBBBBBBBBBBBBBBBBBBBBB',
      'IGQVJXAAAAAAAAAAAAAAAAAAAAAAAA',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    ];
    for (const secret of secrets) {
      const out = redact(`the provider said: ${secret} is invalid`);
      expect(out, `leaked: ${secret}`).not.toContain(secret);
    }
  });

  it('removes labelled secrets whatever the punctuation around them', () => {
    for (const line of [
      'access_token=EAAsomethingsecret123',
      '"apikey": "abcdefghijklmnop"',
      "client_secret: 'zyxwvutsrqponml'",
      'Authorization: Bearer abcdefghijklmnopqrst',
      'password = correcthorsebattery',
    ]) {
      const out = redact(line);
      expect(out, `leaked from: ${line}`).toContain('[redacted]');
    }
  });

  it('leaves an ordinary error readable', () => {
    const message = 'Instagram rejected the media: the video is longer than 90 seconds';
    expect(redact(message)).toBe(message);
  });

  it('truncates output a provider made enormous', () => {
    const out = redact('x'.repeat(50_000));
    expect(out.length).toBeLessThan(4_100);
    expect(out.endsWith('…truncated')).toBe(true);
  });
});

describe('recognising the same failure twice', () => {
  it('gives one fingerprint to runs that differ only in ids and times', () => {
    const a = failureFingerprint(
      'publish_post',
      'Scheduled post 3f1b2c4d-1111-2222-3333-444455556666 failed at 2026-09-01T10:00:00Z after 3 attempts',
    );
    const b = failureFingerprint(
      'publish_post',
      'Scheduled post 9a8b7c6d-9999-8888-7777-666655554444 failed at 2026-09-02T22:31:07Z after 5 attempts',
    );
    expect(a).toBe(b);
  });

  it('separates genuinely different failures', () => {
    const media = failureFingerprint('publish_post', 'Instagram rejected the media');
    const token = failureFingerprint('publish_post', 'Your Instagram connection expired');
    expect(media).not.toBe(token);
  });

  it('separates the same error arising in different jobs', () => {
    expect(failureFingerprint('publish_post', 'timed out')).not.toBe(
      failureFingerprint('generate_content', 'timed out'),
    );
  });

  it('never puts a secret in the fingerprint seed it returns', () => {
    const print = failureFingerprint('publish_post', 'token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(print).toMatch(/^[a-z0-9]{1,8}$/);
  });
});
