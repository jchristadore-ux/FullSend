/**
 * The file TikTok fetches to prove you own this host.
 *
 * TikTok refuses a Terms, Privacy or media URL on an unverified host. DNS
 * verification needs a zone you control, which rules it out on a *.vercel.app
 * subdomain, so this file is the only route available until there is a custom
 * domain.
 *
 * It is a static file in `public/`, deliberately. It was served by a route
 * handler reading an environment variable, which is tidier — no commit needed
 * to re-verify — and put a cold-starting serverless function in front of the
 * one request TikTok makes. A static file is answered from the CDN. TikTok's
 * own instructions say to upload a file; this is that file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PATH = join(process.cwd(), 'public', 'tiktok-developers-site-verification.txt');

describe('tiktok site verification file', () => {
  const raw = readFileSync(PATH, 'utf8');

  it('is exactly the signature, with nothing around it', () => {
    // No trailing newline. TikTok compares the body against the signature it
    // generated, and a newline this file added is a byte that signature does
    // not have. Every other explanation has been eliminated, so this one gets
    // removed rather than assumed harmless.
    expect(raw).toBe(raw.trim());
    expect(raw.startsWith('tiktok-developers-site-verification=')).toBe(true);
    expect(raw).not.toContain('\n');
  });

  it('has a signature after the equals sign', () => {
    const [, signature] = raw.trim().split('=');
    expect(signature).toBeTruthy();
    expect(signature.length).toBeGreaterThan(8);
  });
});
