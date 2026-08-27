/**
 * The file TikTok fetches to prove you own this host.
 *
 * TikTok refuses a Terms, Privacy or media URL on an unverified host. DNS
 * verification needs a zone you control, which rules it out on a *.vercel.app
 * subdomain, so this file is the only route available until there is a custom
 * domain — and TikTok compares the body byte for byte against the signature it
 * issued. A stray space or a missing newline fails the check while looking
 * exactly like a correct file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CODE = 'tiktok-developers-site-verification=AbC123XyZ';

async function fetchFile(code: string | undefined): Promise<Response> {
  vi.resetModules();
  if (code === undefined) delete process.env.TIKTOK_VERIFICATION_CODE;
  else process.env.TIKTOK_VERIFICATION_CODE = code;

  const { GET } = await import('@/app/tiktok-developers-site-verification.txt/route');
  return GET();
}

describe('tiktok site verification file', () => {
  const original = process.env.TIKTOK_VERIFICATION_CODE;
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    if (original === undefined) delete process.env.TIKTOK_VERIFICATION_CODE;
    else process.env.TIKTOK_VERIFICATION_CODE = original;
  });

  it('serves the signature as plain text', async () => {
    const res = await fetchFile(CODE);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    // Byte for byte: the signature and a single newline. Nothing else.
    expect(await res.text()).toBe(`${CODE}\n`);
  });

  it('trims whitespace pasted in with the value', async () => {
    // Copying out of TikTok's dialog picks up padding more often than not,
    // and a leading space is invisible in a hosting dashboard.
    const res = await fetchFile(`  ${CODE}\n\n`);

    expect(await res.text()).toBe(`${CODE}\n`);
  });

  it('404s when unset rather than serving an empty file', async () => {
    // An empty 200 fails TikTok's check with the same "not verified" message
    // as a missing file, which hides whether it is unconfigured or wrong.
    const res = await fetchFile(undefined);

    expect(res.status).toBe(404);
    expect(await res.text()).toContain('TIKTOK_VERIFICATION_CODE');
  });

  it('404s on a blank value, which is the same as unset', async () => {
    const res = await fetchFile('   ');

    expect(res.status).toBe(404);
  });

  it('is never cached', async () => {
    // Verification is retried right after the value is pasted in; a cached
    // 404 would fail the retry and send you looking for a problem that is
    // already fixed.
    const res = await fetchFile(CODE);

    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});
