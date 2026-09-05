/**
 * At-rest encryption for platform OAuth tokens.
 *
 * AES-256-GCM with a random 12-byte IV per record. The key never leaves the
 * server; ciphertext is the only form a token takes in the database, and no API
 * route ever returns a decrypted token to a client.
 */
import 'server-only';
import crypto from 'node:crypto';
import { env } from './env';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

let cachedKey: Buffer | null = null;

/** Accepts base64 or hex; must decode to exactly 32 bytes. */
export function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = env.encryptionKey;
  if (!raw) {
    throw new Error(
      'FULLSEND_ENCRYPTION_KEY is not set. Generate one with: ' +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw new Error(
      `FULLSEND_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). ` +
        'Use a base64 or hex encoded 256-bit key.',
    );
  }
  cachedKey = key;
  return key;
}

/** Test seam: lets suites install a deterministic key without touching env. */
export function __setKeyForTesting(key: Buffer | null): void {
  cachedKey = key;
}

/**
 * `aad` binds ciphertext to a context (e.g. the social account id) so a token
 * row cannot be lifted and replayed against a different account.
 */
export function encryptSecret(plaintext: string, aad?: string): string {
  const key = loadKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(payload: string, aad?: string): string {
  const key = loadKey();
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed encrypted payload');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Constant-time compare for webhook signatures and cron secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Signs OAuth `state` so a callback cannot be forged or replayed elsewhere. */
export function signState(payload: Record<string, unknown>, ttlSeconds = 900): string {
  const body = { ...payload, exp: Date.now() + ttlSeconds * 1000, nonce: crypto.randomUUID() };
  const json = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', loadKey()).update(json).digest('base64url');
  return `${json}.${mac}`;
}

export function verifyState<T = Record<string, unknown>>(state: string): T {
  const [json, mac] = state.split('.');
  if (!json || !mac) throw new Error('Invalid OAuth state');
  const expected = crypto.createHmac('sha256', loadKey()).update(json).digest('base64url');
  if (!timingSafeEqual(mac, expected)) throw new Error('OAuth state signature mismatch');
  const body = JSON.parse(Buffer.from(json, 'base64url').toString('utf8'));
  if (typeof body.exp !== 'number' || body.exp < Date.now()) {
    throw new Error('OAuth state expired — restart the connection');
  }
  return body as T;
}

/** PKCE pair for TikTok's OAuth, which requires S256. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
