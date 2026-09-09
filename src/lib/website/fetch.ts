/**
 * SSRF-safe HTML fetch for website product sources.
 *
 * Manual redirects so every hop is re-validated. Hard caps on time and body
 * size so a hostile or accidental huge response cannot hang the worker.
 */
import 'server-only';
import { createHash } from 'node:crypto';
import { FullSendError } from '../errors';
import { logger } from '../logger';
import { assertSafePublicUrl } from './ssrf';

const log = logger('website.fetch');

export const WEBSITE_FETCH_TIMEOUT_MS = 10_000;
export const WEBSITE_MAX_BODY_BYTES = 1_500_000;
export const WEBSITE_MAX_REDIRECTS = 5;

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  body: string;
  contentHash: string;
}

export async function fetchPublicHtml(
  input: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<FetchedPage> {
  const timeoutMs = opts.timeoutMs ?? WEBSITE_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? WEBSITE_MAX_BODY_BYTES;

  let current = await assertSafePublicUrl(input);
  const requestedUrl = current.href;

  for (let hop = 0; hop <= WEBSITE_MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(current.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'User-Agent': 'FullSendBot/1.0 (+https://fullsend.app; product-intelligence)',
        },
      });
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof Error && e.name === 'AbortError') {
        throw new FullSendError('website_timeout', `Timed out fetching ${current.href}`, {
          status: 504,
          retryable: true,
          remedy: 'The site took too long to respond. Try again, or use a faster public page.',
        });
      }
      throw new FullSendError(
        'website_fetch_failed',
        `Could not fetch ${current.href}: ${e instanceof Error ? e.message : String(e)}`,
        {
          status: 502,
          retryable: true,
          remedy: 'Check the URL is publicly reachable over https, then try again.',
        },
      );
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) {
        throw new FullSendError('website_bad_redirect', `${current.href} redirected without a Location`, {
          status: 502,
          remedy: 'The site returned a redirect FullSend could not follow. Try the final URL directly.',
        });
      }
      const next = new URL(location, current);
      current = await assertSafePublicUrl(next.href);
      continue;
    }

    if (res.status >= 400) {
      throw new FullSendError(
        'website_http_error',
        `${current.href} answered HTTP ${res.status}`,
        {
          status: 502,
          retryable: res.status >= 500,
          remedy: 'Confirm the page is public and returns HTML, then try again.',
        },
      );
    }

    const contentType = res.headers.get('content-type');
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new FullSendError(
        'website_not_html',
        `${current.href} is not HTML (${contentType})`,
        {
          status: 400,
          remedy: 'Paste a product marketing page (HTML), not an API, image, or download URL.',
        },
      );
    }

    const body = await readBodyLimited(res, maxBytes);
    const contentHash = createHash('sha256').update(body).digest('hex');

    log.info('fetched public html', {
      requested: requestedUrl,
      final: current.href,
      bytes: Buffer.byteLength(body, 'utf8'),
      status: res.status,
    });

    return {
      requestedUrl,
      finalUrl: current.href,
      status: res.status,
      contentType,
      body,
      contentHash,
    };
  }

  throw new FullSendError('website_too_many_redirects', `Too many redirects from ${requestedUrl}`, {
    status: 502,
    remedy: 'Try the final destination URL directly.',
  });
}

async function readBodyLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new FullSendError('website_too_large', `Response exceeded ${maxBytes} bytes`, {
        status: 400,
        remedy: 'That page is too large for FullSend to ingest. Try a lighter marketing page.',
      });
    }
    chunks.push(value);
  }
  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return merged.toString('utf8');
}
