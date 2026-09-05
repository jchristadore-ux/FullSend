import 'server-only';
import { env } from '../env';
import { timingSafeEqual } from '../crypto';

/**
 * Validates cron / ops secrets from Authorization Bearer, x-cron-secret, or raw value.
 * Constant-time compare; fails closed if the env secret is unset or lengths differ.
 */
export function cronSecretValid(value: string | null): boolean {
  const secret = env.jobs.cronSecret;
  if (!secret || !value) return false;
  const trimmed = value.trim();
  const provided = trimmed.toLowerCase().startsWith('bearer ')
    ? trimmed.slice(7).trim()
    : trimmed;
  if (!provided || provided.length !== secret.length) return false;
  return timingSafeEqual(provided, secret);
}
