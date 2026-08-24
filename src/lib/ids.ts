import crypto from 'node:crypto';

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}

/** Stable content fingerprint, used by the dedup guard. */
export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
