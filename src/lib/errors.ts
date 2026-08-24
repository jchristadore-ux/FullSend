/**
 * FullSend errors always carry a remedy. Nothing fails silently, and nothing
 * fails with a message the founder cannot act on.
 */

export class FullSendError extends Error {
  readonly code: string;
  readonly status: number;
  /** Plain-language next step shown in the UI. */
  readonly remedy: string | null;
  /** True when a retry could plausibly succeed without human intervention. */
  readonly retryable: boolean;
  readonly meta: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    opts: {
      status?: number;
      remedy?: string | null;
      retryable?: boolean;
      meta?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'FullSendError';
    this.code = code;
    this.status = opts.status ?? 500;
    this.remedy = opts.remedy ?? null;
    this.retryable = opts.retryable ?? false;
    this.meta = opts.meta ?? {};
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      remedy: this.remedy,
      retryable: this.retryable,
    };
  }
}

export const notFound = (what: string) =>
  new FullSendError('not_found', `${what} not found`, { status: 404 });

export const forbidden = (detail = 'You do not have access to this resource') =>
  new FullSendError('forbidden', detail, { status: 403 });

export const unauthorized = () =>
  new FullSendError('unauthorized', 'Sign in to continue', {
    status: 401,
    remedy: 'Sign in and try again.',
  });

export const badRequest = (detail: string, remedy?: string) =>
  new FullSendError('bad_request', detail, { status: 400, remedy: remedy ?? null });

export const rateLimited = (retryAfterSeconds: number) =>
  new FullSendError('rate_limited', 'Too many requests', {
    status: 429,
    retryable: true,
    remedy: `Wait ${retryAfterSeconds}s and try again.`,
    meta: { retryAfterSeconds },
  });

/**
 * A platform connection needs the user's attention. These surface as the
 * "INSTAGRAM NEEDS ATTENTION" style banner rather than a stack trace.
 */
export function connectionError(
  platform: string,
  detail: string,
  remedy: string,
): FullSendError {
  return new FullSendError('connection_error', detail, {
    status: 409,
    remedy,
    retryable: false,
    meta: { platform, needsAttention: true },
  });
}

export function isFullSendError(e: unknown): e is FullSendError {
  return e instanceof FullSendError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
