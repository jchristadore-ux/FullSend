/**
 * TikTok's URL prefix verification file.
 *
 * TikTok will not accept a Terms of Service URL, a Privacy Policy URL, or a
 * media domain it has not verified you own. On a custom domain you can prove
 * that with a DNS TXT record; on a *.vercel.app subdomain you cannot, because
 * the DNS zone belongs to Vercel. That leaves the file method — serve a
 * signature TikTok generates at
 * `https://<your-host>/tiktok-developers-site-verification.txt` — as the only
 * route available to a deployment that has not bought a domain yet.
 *
 * Served from an environment variable rather than a checked-in file so
 * verifying a URL is a paste into the hosting dashboard, not a commit, a
 * review and a deploy. TikTok reissues the signature whenever you add a
 * property, and each of those round trips would otherwise need a code change.
 *
 * The value is not a secret: it is a public proof of ownership, and TikTok
 * fetches it anonymously. It lives in the environment for convenience, not
 * confidentiality.
 */
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const code = env.tiktok.verificationCode;

  /*
   * A 404 when it is unset, rather than an empty 200.
   *
   * An empty file is a file TikTok fetches, reads, and rejects — and the error
   * it shows then is the same "not verified" you get with no file at all, so
   * the difference between "not configured" and "wrong code" disappears
   * exactly when you need it. Absent means absent.
   */
  if (!code) {
    return new Response(
      'Not configured. Set TIKTOK_VERIFICATION_CODE to the signature TikTok gave you.\n',
      { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  }

  // Exactly what TikTok issued, with a trailing newline and nothing else —
  // it compares the body against the signature it generated.
  return new Response(`${code.trim()}\n`, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
