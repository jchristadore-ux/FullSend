/**
 * Structured logging. Redacts anything that looks like a credential before it
 * can reach a log sink.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const SECRET_KEYS =
  /(token|secret|password|authorization|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|code_verifier)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, scope: string, message: string, meta?: Record<string, unknown>) {
  if (process.env.FULLSEND_LOG_SILENT === 'true') return;
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta ? { meta: redact(meta) } : {}),
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export function logger(scope: string) {
  return {
    debug: (m: string, meta?: Record<string, unknown>) => {
      if (process.env.NODE_ENV !== 'production') emit('debug', scope, m, meta);
    },
    info: (m: string, meta?: Record<string, unknown>) => emit('info', scope, m, meta),
    warn: (m: string, meta?: Record<string, unknown>) => emit('warn', scope, m, meta),
    error: (m: string, meta?: Record<string, unknown>) => emit('error', scope, m, meta),
  };
}

export type Logger = ReturnType<typeof logger>;
