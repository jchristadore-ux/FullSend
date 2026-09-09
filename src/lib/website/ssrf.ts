/**
 * SSRF guards for website ingestion.
 *
 * FullSend fetches founder-supplied URLs. Those URLs must never reach the
 * machine's loopback, link-local, private, or cloud-metadata addresses — and a
 * redirect must not be a way around the first check.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { FullSendError } from '../errors';
import { parseWebsiteUrl } from './url';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

export function ssrfBlocked(detail: string, remedy?: string): FullSendError {
  return new FullSendError('ssrf_blocked', detail, {
    status: 400,
    remedy:
      remedy ??
      'Paste a public https:// website. Internal, local, and cloud-metadata addresses are blocked.',
  });
}

/** True when the literal hostname is never safe to fetch. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  // Decimal / hex / octal IP literals still parse as hostnames in URL; treat
  // any IP-shaped host as an address and run the private-IP check on it.
  return false;
}

/**
 * Block loopback, RFC1918, link-local, CGNAT, and unique-local / link-local v6,
 * plus the classic cloud metadata address.
 */
export function isBlockedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const normalised = ip.toLowerCase();
  if (normalised === '::' || normalised === '::1') return true;
  // IPv4-mapped IPv6
  if (normalised.startsWith(':ffff:')) {
    const v4 = normalised.slice(7);
    if (net.isIPv4(v4)) return isBlockedIpv4(v4);
  }
  // Unique local fc00::/7, link-local fe80::/10
  if (normalised.startsWith('fc') || normalised.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalised)) return true;
  return false;
}

/**
 * Shape-check, block bad hostnames, resolve DNS, and refuse private answers.
 * Call again for every redirect target.
 */
export async function assertSafePublicUrl(input: string): Promise<URL> {
  const url = parseWebsiteUrl(input);

  if (isBlockedHostname(url.hostname)) {
    throw ssrfBlocked(`Refusing to fetch ${url.hostname}`);
  }

  // Literal IP in the URL — no DNS needed, but still must be public.
  if (net.isIP(url.hostname)) {
    if (isBlockedIp(url.hostname)) {
      throw ssrfBlocked(`Refusing to fetch private address ${url.hostname}`);
    }
    return url;
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new FullSendError('website_unresolvable', `Could not resolve ${url.hostname}`, {
      status: 400,
      remedy: 'Check the spelling, or try again when the domain is publicly resolvable.',
      retryable: true,
    });
  }

  if (addresses.length === 0) {
    throw new FullSendError('website_unresolvable', `Could not resolve ${url.hostname}`, {
      status: 400,
      remedy: 'Check the spelling, or try again when the domain is publicly resolvable.',
    });
  }

  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw ssrfBlocked(
        `Refusing to fetch ${url.hostname} — it resolves to a private or link-local address`,
      );
    }
  }

  return url;
}
