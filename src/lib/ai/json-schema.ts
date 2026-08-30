/** Convert Zod schemas into a full local JSON Schema and an Anthropic-safe dialect. */
import { z } from 'zod';
import { logger } from '../logger';

const log = logger('ai');
const cache = new WeakMap<object, Record<string, unknown> | null>();
const anthropicCache = new WeakMap<object, Record<string, unknown> | null>();

/** Full schema. Keep constraints here because local coercion relies on them. */
export function jsonSchemaFor(schema: z.ZodType<unknown>): Record<string, unknown> | null {
  const hit = cache.get(schema);
  if (hit !== undefined) return hit;
  let derived: Record<string, unknown> | null = null;
  try {
    derived = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', cycles: 'ref' }) as Record<string, unknown>;
  } catch (e) {
    log.warn('could not derive a JSON schema for an AI task', { error: String(e) });
  }
  cache.set(schema, derived);
  return derived;
}

/** Anthropic's output_config accepts a narrower JSON-Schema dialect. */
export function anthropicJsonSchemaFor(schema: z.ZodType<unknown>): Record<string, unknown> | null {
  const hit = anthropicCache.get(schema);
  if (hit !== undefined) return hit;
  const raw = jsonSchemaFor(schema);
  const derived = raw ? strictifyForAnthropic(raw) as Record<string, unknown> : null;
  anthropicCache.set(schema, derived);
  return derived;
}

function strictifyForAnthropic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictifyForAnthropic);
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const allowed = new Set([
    'type', 'properties', 'required', 'additionalProperties', 'items',
    'enum', 'const', 'anyOf', 'oneOf', 'allOf', '$ref', '$defs', 'description',
  ]);
  for (const [key, child] of Object.entries(obj)) {
    if (allowed.has(key)) out[key] = strictifyForAnthropic(child);
  }
  if (out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object'))) {
    out.additionalProperties = false;
  }
  return out;
}
