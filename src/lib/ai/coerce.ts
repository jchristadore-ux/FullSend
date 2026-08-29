/**
 * Repairing near-miss model output.
 *
 * A model that writes JSON by hand gets the structure right and the notation
 * wrong: `"confidence": "high"` for a 0-1 number, `"Instagram"` for an enum of
 * lowercase platforms, `"85%"` for a fraction, a bare string where a
 * single-element array was wanted. None of these are disagreements about what
 * the product is — they are typing mistakes, and rejecting a whole analysis
 * over one is how FullSend ended up with nothing queued.
 *
 * So the raw value is walked against the task's JSON Schema first and the
 * unambiguous mistakes are fixed, then Zod validates as strictly as before.
 * Only conversions with exactly one sensible reading are made: anything
 * genuinely ambiguous is left alone for validation to reject, because a wrong
 * repair would put a plausible-looking falsehood in the database, which is
 * worse than a failed step.
 */

type Node = Record<string, unknown>;

/** How far to walk before assuming the schema is pathological. */
const MAX_DEPTH = 24;

/**
 * Words models reach for instead of a number, for scores that run 0 to 1.
 * Only consulted when the schema says the field is a fraction, so "high" can
 * never be read as a score on a field where it might mean something else.
 */
const WORD_SCORES: Record<string, number> = {
  none: 0,
  zero: 0,
  nil: 0,
  'very low': 0.1,
  minimal: 0.1,
  negligible: 0.1,
  low: 0.25,
  weak: 0.25,
  poor: 0.25,
  'low medium': 0.4,
  'medium low': 0.4,
  medium: 0.5,
  moderate: 0.5,
  average: 0.5,
  fair: 0.5,
  unsure: 0.5,
  'medium high': 0.65,
  'high medium': 0.65,
  high: 0.8,
  strong: 0.8,
  good: 0.8,
  confident: 0.8,
  'very high': 0.9,
  certain: 0.95,
  definite: 0.95,
  full: 1,
  complete: 1,
};

/**
 * Fixes what can be fixed without guessing. `root` resolves `$ref`s, which Zod
 * only emits for recursive schemas but which cost nothing to support.
 */
export function coerceToSchema(value: unknown, schema: Node | null | undefined): unknown {
  if (!schema) return value;
  return walk(value, schema, schema, 0);
}

function walk(value: unknown, node: Node | null, root: Node, depth: number): unknown {
  if (!node || depth > MAX_DEPTH) return value;

  const resolved = deref(node, root);
  if (!resolved) return value;

  const branch = pickBranch(value, resolved, root);
  if (branch) return walk(value, branch, root, depth + 1);

  const types = typesOf(resolved);

  // A model that has been told "JSON only" sometimes sends a JSON document as
  // a string. Unwrap it before deciding anything else about it.
  if (typeof value === 'string' && (types.includes('object') || types.includes('array'))) {
    const inner = parseEmbedded(value);
    if (inner !== undefined) return walk(inner, resolved, root, depth + 1);
  }

  if (Array.isArray(value)) {
    if (!types.includes('array') && types.length > 0) return coerceScalar(value, resolved, types);
    return walkArray(value, resolved, root, depth);
  }

  if (isPlainObject(value)) {
    if (types.includes('array')) return walkArray([value], resolved, root, depth);
    return walkObject(value, resolved, root, depth);
  }

  // A single value where a list was wanted. Wrapping is the only reading.
  if (types.includes('array') && value !== null && value !== undefined) {
    return walkArray([value], resolved, root, depth);
  }

  return coerceScalar(value, resolved, types);
}

function walkArray(value: unknown[], node: Node, root: Node, depth: number): unknown[] {
  const items = asNode(node.items);
  if (!items) return value;
  return value.map((entry) => walk(entry, items, root, depth + 1));
}

function walkObject(value: Node, node: Node, root: Node, depth: number): Node {
  const properties = asNode(node.properties);
  const additional = asNode(node.additionalProperties);
  if (!properties && !additional) return value;

  const out: Node = {};
  for (const [key, entry] of Object.entries(value)) {
    const child = asNode(properties?.[key]) ?? additional;
    if (!child) {
      out[key] = entry;
      continue;
    }

    // An explicit null where the schema has a default and no null branch: the
    // model meant "nothing here", which is what the default is for. Dropping
    // the key lets Zod supply it instead of failing on the null.
    if (entry === null && 'default' in deref(child, root)! && !allowsNull(child, root)) continue;

    out[key] = walk(entry, child, root, depth + 1);
  }
  return out;
}

function coerceScalar(value: unknown, node: Node, types: string[]): unknown {
  if (value === null || value === undefined) return value;

  const enumValues = enumOf(node);
  if (enumValues) {
    const matched = matchEnum(value, enumValues);
    if (matched !== undefined) return matched;
    return value;
  }

  if (types.includes('number') || types.includes('integer')) {
    if (typeof value === 'number') return fitNumber(value, node, types);
    if (typeof value === 'string') {
      const parsed = numberFromString(value, node);
      if (parsed !== null) return fitNumber(parsed, node, types);
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  }

  if (types.includes('boolean') && typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['true', 'yes', 'y'].includes(s)) return true;
    if (['false', 'no', 'n'].includes(s)) return false;
    return value;
  }

  if (types.includes('string')) {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value) && value.every(isPrimitive)) return value.join(' ');
  }

  return value;
}

/* ── Reading the schema ─────────────────────────────────────────────────── */

function deref(node: Node, root: Node): Node | null {
  const ref = node.$ref;
  if (typeof ref !== 'string') return node;
  if (!ref.startsWith('#/')) return node;
  let current: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    if (!isPlainObject(current)) return null;
    current = current[decodeURIComponent(segment.replace(/~1/g, '/').replace(/~0/g, '~'))];
  }
  return isPlainObject(current) ? current : null;
}

/**
 * For a union, the branch the value is actually trying to be. Discriminated
 * unions (every optimizer action is one) are settled by their `const` tag;
 * a nullable is settled by whether the value is null. Anything less certain
 * gets no coercion rather than a guessed one.
 */
function pickBranch(value: unknown, node: Node, root: Node): Node | null {
  const union = node.anyOf ?? node.oneOf;
  if (!Array.isArray(union) || union.length === 0) return null;

  const branches = union.filter(isPlainObject).map((b) => deref(b, root)).filter(isNode);
  const real = branches.filter((b) => !typesOf(b).includes('null'));

  if (value === null) return null;
  if (real.length === 1) return real[0];

  if (isPlainObject(value)) {
    const tagged = real.filter((b) => matchesDiscriminator(value, b));
    if (tagged.length === 1) return tagged[0];
  }
  return null;
}

function matchesDiscriminator(value: Node, branch: Node): boolean {
  const properties = asNode(branch.properties);
  if (!properties) return false;
  for (const [key, raw] of Object.entries(properties)) {
    const prop = asNode(raw);
    if (!prop || !('const' in prop)) continue;
    if (value[key] === prop.const) return true;
  }
  return false;
}

function typesOf(node: Node): string[] {
  const t = node.type;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

function allowsNull(node: Node, root: Node): boolean {
  const resolved = deref(node, root);
  if (!resolved) return false;
  if (typesOf(resolved).includes('null')) return true;
  const union = resolved.anyOf ?? resolved.oneOf;
  if (!Array.isArray(union)) return false;
  return union.some((b) => isPlainObject(b) && typesOf(b).includes('null'));
}

function enumOf(node: Node): unknown[] | null {
  if (Array.isArray(node.enum)) return node.enum;
  if ('const' in node) return [node.const];
  return null;
}

/** Case and separators are notation, not meaning: "Product Demo" is product_demo. */
function matchEnum(value: unknown, options: unknown[]): unknown {
  if (options.includes(value)) return value;
  if (typeof value !== 'string') return undefined;
  const target = normalizeWords(value);
  const matches = options.filter((o) => typeof o === 'string' && normalizeWords(o) === target);
  return matches.length === 1 ? matches[0] : undefined;
}

/* ── Numbers ────────────────────────────────────────────────────────────── */

/** True for the 0-1 score fields, where "high" and "85%" have one reading. */
function isFraction(node: Node): boolean {
  return numberAt(node.minimum) === 0 && numberAt(node.maximum) === 1;
}

function numberFromString(raw: string, node: Node): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  const percent = s.endsWith('%');
  const cleaned = s.replace(/[%,\s]/g, '').replace(/^\+/, '');
  if (/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(cleaned)) {
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return null;
    return percent && isFraction(node) ? n / 100 : n;
  }

  if (isFraction(node)) {
    const word = WORD_SCORES[normalizeWords(s)];
    if (word !== undefined) return word;

    // "8/10", "8 out of 10"
    const ratio = s.match(/^(\d+\.?\d*)\s*(?:\/|out of)\s*(\d+\.?\d*)$/);
    if (ratio) {
      const denominator = Number(ratio[2]);
      if (denominator > 0) return Number(ratio[1]) / denominator;
    }
  }
  return null;
}

/**
 * A fraction given as a percentage (`"confidence": 85`) is the one numeric
 * mistake worth correcting; every other out-of-range number is left to fail,
 * because rescaling it would be inventing a value.
 */
function fitNumber(n: number, node: Node, types: string[]): number {
  let out = n;
  if (isFraction(node) && out > 1 && out <= 100) out = out / 100;
  if (types.includes('integer') && !types.includes('number') && !Number.isInteger(out)) {
    out = Math.round(out);
  }
  return out;
}

function numberAt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/* ── Small helpers ──────────────────────────────────────────────────────── */

function parseEmbedded(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function normalizeWords(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function isPrimitive(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function isPlainObject(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNode(v: Node | null): v is Node {
  return v !== null;
}

function asNode(v: unknown): Node | null {
  return isPlainObject(v) ? v : null;
}
