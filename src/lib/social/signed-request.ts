/**
 * Meta's `signed_request`.
 *
 * Meta POSTs one to the deauthorize and data-deletion callbacks when someone
 * removes the app or asks for their data back. It is
 * `base64url(HMAC-SHA256) + "." + base64url(JSON)`, signed with the app secret,
 * and it is the only proof that the request came from Meta — these endpoints
 * are public, so anything that skips the check lets a stranger disconnect
 * accounts by guessing a user id.
 */
import 'server-only';
import crypto from 'node:crypto';

export interface SignedRequest {
  /** Instagram-scoped user id of the person who removed the app. */
  user_id?: string;
  algorithm?: string;
  issued_at?: number;
  [key: string]: unknown;
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Returns the payload, or null when the signature does not verify.
 *
 * Null covers every failure — bad shape, wrong algorithm, forged signature —
 * because the caller's response is the same in all of them and distinguishing
 * them out loud only helps whoever is probing.
 */
export function parseSignedRequest(raw: string, appSecret: string): SignedRequest | null {
  const [encodedSignature, encodedPayload] = raw.split('.', 2);
  if (!encodedSignature || !encodedPayload) return null;

  let payload: SignedRequest;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
  } catch {
    return null;
  }

  // Meta signs with HMAC-SHA256. Anything else is either a forgery or a
  // version this code has not been reviewed against; both are refused.
  if (payload.algorithm && payload.algorithm.toUpperCase() !== 'HMAC-SHA256') return null;

  const expected = crypto.createHmac('sha256', appSecret).update(encodedPayload).digest();
  const actual = base64UrlDecode(encodedSignature);

  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and that throw is itself a signal.
  if (expected.length !== actual.length) return null;
  return crypto.timingSafeEqual(expected, actual) ? payload : null;
}
