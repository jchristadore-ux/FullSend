/**
 * Scrubbing secrets out of text that is about to leave the building.
 *
 * Error messages are the most likely place for a credential to escape: a
 * provider echoes the request back, a connection string appears in a driver
 * error, a token ends up in a URL. Any of those written into a GitHub issue is
 * a leak that survives deletion, because issues are indexed and mirrored.
 *
 * The rules below are deliberately broad. A redacted word that turned out to
 * be harmless costs nothing; a missed one cannot be taken back.
 */

interface Rule {
  pattern: RegExp;
  as: string;
}

const RULES: Rule[] = [
  // Postgres and other connection strings, password and all.
  { pattern: /\b[a-z+]+:\/\/[^\s:@/]+:[^\s@]+@[^\s]+/gi, as: '[connection-string]' },
  // Anthropic, OpenAI, GitHub, Meta, Stripe and Supabase key shapes.
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, as: '[api-key]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, as: '[github-token]' },
  { pattern: /\b(?:rk|pk|sk)_(?:live|test)_[A-Za-z0-9]{8,}/g, as: '[stripe-key]' },
  { pattern: /\bEAA[A-Za-z0-9]{20,}/g, as: '[meta-token]' },
  { pattern: /\bIGQ[A-Za-z0-9_-]{20,}/g, as: '[instagram-token]' },
  // Any JWT — Supabase anon and service-role keys are both this shape.
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, as: '[jwt]' },
  // `access_token=…`, `"apikey": "…"`, `password: …` and friends.
  {
    pattern:
      /\b(access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|client[_-]?secret|password|authorization|bearer)\b(["'\s:=]+)([^\s"',&}]{8,})/gi,
    as: '$1$2[redacted]',
  },
];

/**
 * Redacts anything credential-shaped, and truncates.
 *
 * The length cap is part of the safety: a provider that returns its whole
 * request on error can produce megabytes, and the useful part of an error is
 * almost always at the front.
 */
export function redact(text: string, maxLength = 4000): string {
  let out = text;
  for (const rule of RULES) out = out.replace(rule.pattern, rule.as);
  if (out.length > maxLength) out = `${out.slice(0, maxLength)}\n…truncated`;
  return out;
}

/**
 * A stable identity for "this failure, again".
 *
 * Two runs of the same bug produce error text differing only in ids, times and
 * counts. Normalising those away lets a recurrence be recognised as the same
 * problem rather than filed as a new one.
 */
export function failureFingerprint(jobType: string, message: string): string {
  const normalized = redact(message, 400)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/g, '<time>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  let hash = 0;
  const seed = `${jobType}|${normalized}`;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).padStart(6, '0').slice(0, 8);
}
