/**
 * Ingest responses use the contract's own error shape — `{ error, details }`
 * — rather than the app's `{ error, message, remedy }`, because the reader is
 * another service, not a founder. `retryable` mirrors the HTTP status: every
 * 5xx (and 429) may be retried with the same idempotency key.
 */
export class IngestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, code: string, details: unknown, opts: { retryAfterSeconds?: number } = {}) {
    super(typeof details === 'string' ? details : code);
    this.name = 'IngestError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }

  get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }

  toJSON() {
    return { error: this.code, details: this.details, retryable: this.retryable };
  }
}

export function isIngestError(e: unknown): e is IngestError {
  return e instanceof IngestError;
}
