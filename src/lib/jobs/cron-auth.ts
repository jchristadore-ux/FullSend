import 'server-only';
import { timingSafeEqual } from '../crypto';
import { env } from '../env';

/**
 * Validates Authorization against CRON_SECRET.
 * Fail closed if unset. Constant-time compare after optional Bearer strip.
 */
export function cronSecretValid(value: string | null): boolean {
  const secret = env.jobs.cronSecret;
  if (!secret) return false;
  if (!value) return false;
  const trimmed = value.trim();
  const provided = trimmed.startsWith('Bearer ')
    ? trimmed.slice('Bearer '.length).trim()
    : trimmed;
  if (!provided) return false;
  return timingSafeEqual(provided, secret);
}
