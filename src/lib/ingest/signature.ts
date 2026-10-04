/**
 * Request signing for the ingest API.
 *
 *   X-Brovisional-Timestamp: <unix seconds>
 *   X-Brovisional-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 *
 * Verified against the raw body bytes exactly as received — never a
 * re-serialised JSON, which would not round-trip. DELETE has an empty body, so
 * the signed string is `${timestamp}.`.
 *
 * Both the current and the previous secret are accepted so a rotation needs
 * no coordinated cutover. Comparison is constant-time. Nothing here ever logs
 * or returns a secret or a computed signature.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TIMESTAMP_HEADER = 'x-brovisional-timestamp';
export const SIGNATURE_HEADER = 'x-brovisional-signature';
/** Maximum clock difference, either direction. */
export const SIGNATURE_WINDOW_SECONDS = 300;

export type SignatureFailure =
  | 'not_configured'
  | 'missing_headers'
  | 'malformed_timestamp'
  | 'stale_timestamp'
  | 'malformed_signature'
  | 'invalid_signature';

export type SignatureResult =
  | { ok: true; secret: 'current' | 'previous' }
  | { ok: false; reason: SignatureFailure; details: string };

export function sign(secret: string, timestamp: string | number, rawBody: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `sha256=${mac}`;
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

export function verifySignature(input: {
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  secrets: { current?: string | null; previous?: string | null };
  nowSeconds?: number;
}): SignatureResult {
  const { current, previous } = input.secrets;
  if (!current && !previous) {
    return { ok: false, reason: 'not_configured', details: 'Ingest is not configured on this server' };
  }
  if (!input.timestamp || !input.signature) {
    return {
      ok: false,
      reason: 'missing_headers',
      details: 'X-Brovisional-Timestamp and X-Brovisional-Signature are both required',
    };
  }
  const ts = input.timestamp.trim();
  if (!/^\d{1,12}$/.test(ts)) {
    return { ok: false, reason: 'malformed_timestamp', details: 'Timestamp must be unix seconds' };
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > SIGNATURE_WINDOW_SECONDS) {
    return {
      ok: false,
      reason: 'stale_timestamp',
      details: `Timestamp is outside the ${SIGNATURE_WINDOW_SECONDS}s window`,
    };
  }
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(input.signature.trim());
  if (!m) {
    return {
      ok: false,
      reason: 'malformed_signature',
      details: 'Signature must be sha256=<64 hex characters>',
    };
  }
  const given = m[1]!.toLowerCase();

  // Compute both before deciding, so timing does not reveal which matched.
  const matchCurrent = current ? safeEqualHex(given, sign(current, ts, input.rawBody).slice(7)) : false;
  const matchPrevious = previous ? safeEqualHex(given, sign(previous, ts, input.rawBody).slice(7)) : false;
  if (matchCurrent) return { ok: true, secret: 'current' };
  if (matchPrevious) return { ok: true, secret: 'previous' };
  return { ok: false, reason: 'invalid_signature', details: 'Signature does not match' };
}
