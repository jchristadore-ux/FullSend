/**
 * The shape, written down for the model.
 *
 * Every generation was validated against a Zod schema, but the model was only
 * ever told about that schema in prose ("Return JSON only"). It had to guess
 * field names, types and ranges from the surrounding instructions, and a single
 * wrong guess — `"confidence": "high"` where a 0-1 number was wanted — failed
 * the whole step and, with it, everything downstream of it.
 *
 * Deriving the JSON Schema from the Zod schema means the prompt and the
 * validator can never drift apart: they are the same object.
 */
import { z } from 'zod';
import { logger } from '../logger';

const log = logger('ai');

/** Derivation is pure per schema, and schemas are module-level constants. */
const cache = new WeakMap<object, Record<string, unknown> | null>();

/**
 * The JSON Schema for a Zod schema, or null if it cannot be represented.
 *
 * `io: 'input'` matters: it describes what the model should send, so fields
 * carrying a `.default()` are advertised as optional rather than required.
 * A schema that will not convert is not worth failing a generation over — the
 * call simply goes out as it did before.
 */
export function jsonSchemaFor(schema: z.ZodType<unknown>): Record<string, unknown> | null {
  const hit = cache.get(schema);
  if (hit !== undefined) return hit;

  let derived: Record<string, unknown> | null = null;
  try {
    derived = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
      cycles: 'ref',
    }) as Record<string, unknown>;
    // The dialect line is for validators, not for a model reading a prompt.
    delete derived.$schema;
  } catch (e) {
    log.warn('could not derive a JSON schema for an AI task', { error: String(e) });
    derived = null;
  }

  cache.set(schema, derived);
  return derived;
}
