import 'server-only';
import { env } from './env';

/**
 * The address published on the legal pages, or null when the operator has not
 * set one.
 *
 * Returning null rather than a plausible-looking default is deliberate: a
 * privacy policy pointing at an address nobody reads is worse than one that
 * admits it is incomplete, and platform reviewers do email it.
 */
export function legalContact(): string | null {
  return env.contactEmail ?? null;
}

/** The entity named as the operator in the policies. */
export function legalEntity(): string {
  return env.legalEntity;
}
