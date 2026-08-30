/** Convert a Zod schema into the strict JSON Schema accepted by Anthropic structured output. */
import { z } from 'zod';
import { logger } from '../logger';

const log = logger('ai');
const cache = new WeakMap<object, Record<string, unknown> | null>();

function strictify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictify);
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(obj)) {
    // Anthropic's schema dialect rejects these JSON Schema keywords.
    if (key === '$schema' || key === 'maxItems' || key === 'minItems') continue;
    out[key] = strictify(child);
  }
  const isObject = out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object'));
  if (isObject) out.additionalProperties = false;
  return out;
}

export function jsonSchemaFor(schema: z.ZodType<unknown>): Record<string, unknown> | null {
  const hit = cache.get(schema);
  if (hit !== undefined) return hit;
  let derived: Record<string, unknown> | null = null;
  try {
    const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', cycles: 'ref' }) as Record<string, unknown>;
    derived = strictify(raw) as Record<string, unknown>;
  } catch (e) {
    log.warn('could not derive a JSON schema for an AI task', { error: String(e) });
  }
  cache.set(schema, derived);
  return derived;
}
