/**
 * Website URL validation for product sources.
 *
 * This is the shape check only — host/IP safety lives in `ssrf.ts` and runs
 * again on every redirect hop. Keeping the two apart means the onboarding form
 * can reject obvious garbage without doing DNS.
 */
import { badRequest } from '../errors';

const MAX_URL_LENGTH = 2048;

/** Parse and shape-check a founder-pasted website URL. Does not touch the network. */
export function parseWebsiteUrl(input: string): URL {
  const raw = input.trim();
  if (!raw) {
    throw badRequest('Paste a website URL', 'Example: https://yourproduct.com');
  }
  if (raw.length > MAX_URL_LENGTH) {
    throw badRequest('That URL is too long', 'Use a shorter https:// address.');
  }

  let url: URL;
  try {
    // Allow bare domains by assuming https — founders paste both.
    url = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw badRequest(
      'Could not read that as a URL',
      'Paste a full address like https://yourproduct.com',
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest(
      'Only http and https websites are supported',
      'Paste a public https:// URL — not file, ftp, or another scheme.',
    );
  }

  if (url.username || url.password) {
    throw badRequest(
      'URLs with usernames or passwords are not allowed',
      'Paste the public site address without credentials.',
    );
  }

  if (!url.hostname || url.hostname.includes(' ')) {
    throw badRequest('That URL is missing a hostname', 'Example: https://yourproduct.com');
  }

  url.hash = '';
  return url;
}

/** Normalise for storage and resume matching. */
export function canonicalWebsiteUrl(input: string): string {
  const url = parseWebsiteUrl(input);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }
  if ((url.pathname === '' || url.pathname === '/') && !url.search) {
    return url.origin;
  }
  // Drop a trailing slash on paths without a query so /about and /about/ match.
  if (!url.search && url.pathname.endsWith('/') && url.pathname.length > 1) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

/** A short product name from the hostname when we have not fetched a title yet. */
export function nameFromWebsiteUrl(input: string): string {
  const host = parseWebsiteUrl(input).hostname.replace(/^www\./i, '');
  const base = host.split('.')[0] || host;
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
