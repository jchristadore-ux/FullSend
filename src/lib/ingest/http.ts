/**
 * HTTP layer for /api/ingest/posts.
 *
 * Order matters: a cheap per-IP limit, then the raw body, then the signature
 * over those exact bytes, then the per-sender limit, and only then JSON
 * parsing and validation. Nothing is parsed for a request that is not signed.
 */
import 'server-only';
import { env } from '../env';
import { isFullSendError } from '../errors';
import { logger } from '../logger';
import { check, LIMITS } from '../rate-limit';
import { IngestError, isIngestError } from './errors';
import { IDEMPOTENCY_KEY_RE, ingestPostSchema, issueDetails } from './schema';
import { defaultIngestDeps, ingestPost, withdrawPost, type IngestDeps } from './service';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from './signature';

const log = logger('ingest.http');

export const MAX_BODY_BYTES = 256 * 1024;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return (fwd?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown').slice(0, 64);
}

function limit(key: string, rule: { limit: number; windowMs: number }): void {
  try {
    check(key, rule);
  } catch (e) {
    const retry = isFullSendError(e) ? Number(e.meta.retryAfterSeconds ?? 60) : 60;
    throw new IngestError(429, 'rate_limited', `Too many requests; retry in ${retry}s`, { retryAfterSeconds: retry });
  }
}

function authenticate(req: Request, rawBody: string): 'current' | 'previous' {
  const result = verifySignature({
    timestamp: req.headers.get(TIMESTAMP_HEADER),
    signature: req.headers.get(SIGNATURE_HEADER),
    rawBody,
    secrets: {
      current: env.ingest.brovisionalSecret,
      previous: env.ingest.brovisionalSecretPrevious,
    },
  });
  if (result.ok) return result.secret;
  if (result.reason === 'not_configured') {
    throw new IngestError(503, 'ingest_not_configured', 'BROVISIONAL_INGEST_SECRET is not set on FullSend');
  }
  throw new IngestError(401, result.reason, result.details);
}

function toResponse(e: unknown, path: string): Response {
  if (isIngestError(e)) {
    if (e.status >= 500) log.error('ingest request failed', { path, code: e.code, status: e.status });
    else log.warn('ingest request refused', { path, code: e.code, status: e.status });
    return json(e.status, e.toJSON(), e.retryAfterSeconds ? { 'Retry-After': String(e.retryAfterSeconds) } : {});
  }
  if (isFullSendError(e) && e.status >= 400 && e.status < 500) {
    log.warn('ingest request refused', { path, code: e.code, status: e.status });
    return json(400, { error: e.code, details: e.message, retryable: false });
  }
  log.error('ingest request crashed', { path, error: e instanceof Error ? e.message : String(e) });
  return json(500, { error: 'internal_error', details: 'Something went wrong on FullSend; retry', retryable: true });
}

export async function handleIngestPost(req: Request, deps: IngestDeps = defaultIngestDeps): Promise<Response> {
  const path = '/api/ingest/posts';
  try {
    limit(`ingest-ip:${clientIp(req)}`, LIMITS.ingestUnauthenticated);
    const raw = await req.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      throw new IngestError(413, 'payload_too_large', `Body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    const signedWith = authenticate(req, raw);
    limit('ingest:brovisional', LIMITS.ingest);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new IngestError(400, 'invalid_json', 'Body is not valid JSON');
    }
    const parsed = ingestPostSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new IngestError(400, 'validation_failed', issueDetails(parsed.error));
    }
    if (signedWith === 'previous') log.info('ingest signed with the previous secret', { path });

    const result = await ingestPost(parsed.data, deps);
    return json(200, result);
  } catch (e) {
    return toResponse(e, path);
  }
}

export async function handleIngestDelete(
  req: Request,
  rawKey: string,
  deps: IngestDeps = defaultIngestDeps,
): Promise<Response> {
  const path = '/api/ingest/posts/[idempotency_key]';
  try {
    limit(`ingest-ip:${clientIp(req)}`, LIMITS.ingestUnauthenticated);
    const raw = await req.text();
    if (raw.length > 0) throw new IngestError(400, 'unexpected_body', 'DELETE must have an empty body; sign `${timestamp}.`');
    authenticate(req, '');
    limit('ingest:brovisional', LIMITS.ingest);

    let key: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      throw new IngestError(400, 'validation_failed', [{ path: 'idempotency_key', message: 'not URL-decodable' }]);
    }
    if (!IDEMPOTENCY_KEY_RE.test(key)) {
      throw new IngestError(400, 'validation_failed', [
        { path: 'idempotency_key', message: 'must look like brovisional:<event_type>:<id>' },
      ]);
    }
    return json(200, await withdrawPost(key, deps));
  } catch (e) {
    return toResponse(e, path);
  }
}
