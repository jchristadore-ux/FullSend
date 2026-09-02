/**
 * Brand discovery — reading a product's visual identity out of its repository.
 *
 * A repository that ships a UI has already decided what it looks like. Its
 * colours are in a stylesheet, its type is in a font import, its mark is an SVG
 * in `public/`. Those are facts about the product, sitting in version control,
 * and asking a language model to imagine a brand for a product that already has
 * one is both wasteful and wrong.
 *
 * So nothing here is generative. Every function below is a parser: it either
 * finds a value in a file and records which file it came from, or it returns
 * nothing. There is no "sensible default" anywhere in this module, and that is
 * the point — a field this cannot answer must reach the founder as *unknown*,
 * so they can correct it, rather than as a confident guess they have no reason
 * to doubt. The failure that motivated this module was the opposite: every
 * project's brand profile was written with FullSend's own orange, so every
 * product FullSend marketed looked like FullSend.
 *
 * Ordering is the whole trick. A repository states its colours several times
 * over — a design token, a Tailwind theme, a hex buried in one component — and
 * these disagree. Sources are therefore ranked by how deliberate they are
 * (`SOURCE_RANK`), not by how often a value appears: a colour named
 * `--brand-primary` once is the brand, and a `#ffffff` appearing ninety times
 * is not.
 */
import 'server-only';
import { logger } from '../logger';
import type { GitHubClient, RepoRef, TreeEntry } from '../github/client';

const log = logger('brand.discover');

/** One discovered value, and the file that is answerable for it. */
export interface Discovered<T> {
  value: T;
  source: string;
}

export interface BrandIdentity {
  brand_name?: Discovered<string>;
  primary_color?: Discovered<string>;
  secondary_color?: Discovered<string>;
  accent_color?: Discovered<string>;
  background_color?: Discovered<string>;
  text_color?: Discovered<string>;
  heading_font?: Discovered<string>;
  body_font?: Discovered<string>;
  logo_url?: Discovered<string>;
  logo_dark_url?: Discovered<string>;
  /** Everything read, for the prompt and for the founder's own review. */
  evidence: {
    style_files: string[];
    color_tokens: { name: string; value: string; source: string }[];
    font_families: { value: string; source: string }[];
    logo_candidates: { path: string; url: string }[];
    /** Fields no file in the repository answered. Unknown, not guessed. */
    unresolved: string[];
  };
}

/*
 * Files worth reading, most deliberate first.
 *
 * The cap exists because ingestion is on the critical path of an analysis and
 * a monorepo can carry hundreds of stylesheets. Eight files chosen by rank
 * beat eighty chosen by walking the tree.
 */
const MAX_STYLE_FILES = 8;
const MAX_FILE_BYTES = 200_000;

/**
 * How much a file's word is worth, high to low.
 *
 * A theme or token file exists solely to state the brand, so it wins. A
 * Tailwind config states it too, but is also full of plugin and spacing noise.
 * A global stylesheet is usually right. A component stylesheet is a local
 * decision that happens to contain colours. Nothing below rank 1 can define a
 * brand colour on its own — only fill a slot nothing better claimed.
 */
function sourceRank(path: string): number {
  const p = path.toLowerCase();
  if (/(^|\/)(theme|tokens?|design-tokens?|palette|colou?rs?|brand)\.[a-z]+$/.test(p)) return 5;
  if (/(^|\/)tailwind\.config\.[a-z]+$/.test(p)) return 4;
  if (/(^|\/)(globals?|app|index|main|style|styles)\.(css|scss|sass|less)$/.test(p)) return 3;
  if (/\.(css|scss|sass|less)$/.test(p)) return 2;
  return 1;
}

const STYLE_RE = /\.(css|scss|sass|less)$/i;
const CONFIG_RE = /(^|\/)tailwind\.config\.[cm]?[jt]s$/i;
const SKIP_STYLE =
  /(node_modules|\.min\.css$|vendor|bootstrap|normalize\.css$|reset\.css$|tailwind\.css$|font-?awesome)/i;

/**
 * Reads a repository's visual identity.
 *
 * Best effort throughout: a repository with no stylesheet, a private file that
 * 404s, or a tree that was truncated all produce a partial result with the
 * gaps named in `evidence.unresolved`. Discovery must never be able to fail an
 * analysis — a product whose brand cannot be read is still a product worth
 * marketing, and the founder can fill the profile in by hand.
 */
export async function discoverBrandIdentity(
  ref: RepoRef,
  client: GitHubClient,
  branch: string,
  files: TreeEntry[],
): Promise<BrandIdentity> {
  const identity: BrandIdentity = {
    evidence: {
      style_files: [],
      color_tokens: [],
      font_families: [],
      logo_candidates: [],
      unresolved: [],
    },
  };

  const styleFiles = files
    .filter(
      (f) =>
        (STYLE_RE.test(f.path) || CONFIG_RE.test(f.path)) &&
        !SKIP_STYLE.test(f.path) &&
        f.size < MAX_FILE_BYTES,
    )
    .sort((a, b) => sourceRank(b.path) - sourceRank(a.path) || a.path.length - b.path.length)
    .slice(0, MAX_STYLE_FILES);

  const sources: { path: string; body: string; rank: number }[] = [];
  for (const file of styleFiles) {
    const body = await client.getFile(ref, file.path, branch).catch(() => null);
    if (!body) continue;
    sources.push({ path: file.path, body, rank: sourceRank(file.path) });
    identity.evidence.style_files.push(file.path);
  }

  for (const src of sources) {
    identity.evidence.color_tokens.push(
      ...extractColorTokens(src.body).map((t) => ({ ...t, source: src.path })),
    );
    identity.evidence.font_families.push(
      ...extractFontStacks(src.body).map((value) => ({ value, source: src.path })),
    );
  }

  assignColors(identity, sources);
  assignFonts(identity, sources);
  assignLogos(identity, ref, client, branch, files);

  for (const field of [
    'primary_color',
    'secondary_color',
    'accent_color',
    'background_color',
    'text_color',
    'heading_font',
    'body_font',
    'logo_url',
  ] as const) {
    if (!identity[field]) identity.evidence.unresolved.push(field);
  }

  log.info('brand identity discovered', {
    repo: `${ref.owner}/${ref.name}`,
    styleFiles: identity.evidence.style_files.length,
    tokens: identity.evidence.color_tokens.length,
    logos: identity.evidence.logo_candidates.length,
    unresolved: identity.evidence.unresolved.length,
  });

  return identity;
}

/* ── Colour ─────────────────────────────────────────────────────────────── */

/** `#abc`, `#aabbcc`, `#aabbccdd`. Bare, so a match must be bounded by the caller. */
const HEX = '#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})';

/**
 * Named colour declarations: CSS custom properties, SCSS/Less variables, and
 * the `key: '#hex'` pairs a Tailwind config or a token module is written as.
 *
 * The name is what makes a colour usable — `--brand-primary` says which slot
 * it fills, where a loose hex in a gradient says nothing. Values that are
 * references to other variables are skipped rather than resolved: one level of
 * indirection is common and cheap to follow, but a chain is where a parser
 * starts inventing, and a wrong colour presented confidently is the failure
 * this module exists to prevent.
 */
export function extractColorTokens(body: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const push = (name: string, value: string) => {
    const hex = normaliseHex(value);
    if (hex) out.push({ name: name.toLowerCase(), value: hex });
  };

  // --brand-primary: #ff5a1f;  and  $brand-primary: #ff5a1f;  and  @primary: ...
  for (const m of body.matchAll(
    new RegExp(`(?:--|\\$|@)([a-zA-Z0-9_-]{2,60})\\s*:\\s*(${HEX})\\b`, 'g'),
  )) {
    push(m[1], m[2]);
  }

  // primary: '#ff5a1f'  /  "primary": "#ff5a1f"  — Tailwind configs, token modules.
  for (const m of body.matchAll(
    new RegExp(`["']?([a-zA-Z0-9_-]{2,60})["']?\\s*:\\s*["'](${HEX})["']`, 'g'),
  )) {
    push(m[1], m[2]);
  }

  return out;
}

function normaliseHex(raw: string): string | null {
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(raw.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 4) h = h.slice(0, 3); // #rgba -> #rgb, alpha is not brand
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return null;
  return `#${h}`;
}

/*
 * What a token's name says about the slot it fills.
 *
 * Ordered because names overlap: `--primary-foreground` is a text colour that
 * contains the word "primary", and matching "primary" first would make it the
 * brand colour. Foreground and background are therefore tested before accent
 * and primary, and every pattern that could collide is anchored.
 */
const SLOT_PATTERNS: { slot: keyof BrandIdentity & string; re: RegExp }[] = [
  { slot: 'background_color', re: /^(--)?(color-)?(bg|background|surface|canvas|base)(-color)?$/ },
  { slot: 'background_color', re: /(^|-)(background|bg)(-(default|base|primary|body|page))?$/ },
  { slot: 'text_color', re: /^(--)?(color-)?(fg|foreground|text|ink|copy|body-text)(-color)?$/ },
  { slot: 'text_color', re: /(^|-)(foreground|text)(-(default|base|primary|body))?$/ },
  { slot: 'accent_color', re: /(^|-)(accent|highlight)(-color)?$/ },
  { slot: 'secondary_color', re: /(^|-)(secondary|brand-secondary)(-color)?$/ },
  { slot: 'primary_color', re: /(^|-)(brand|primary|brand-primary|main)(-color)?$/ },
];

function assignColors(
  identity: BrandIdentity,
  sources: { path: string; body: string; rank: number }[],
): void {
  /*
   * Highest-ranked source first, and within a source in declaration order, so
   * the first thing a theme file says about a slot wins. Later files fill only
   * what is still empty — a component stylesheet cannot overrule a token file.
   */
  const ranked = [...sources].sort((a, b) => b.rank - a.rank);

  for (const src of ranked) {
    for (const token of extractColorTokens(src.body)) {
      for (const { slot, re } of SLOT_PATTERNS) {
        if (!re.test(token.name)) continue;
        if (identity[slot]) break;
        // A token file naming a slot is deliberate; a component file is not.
        if (src.rank < 2) break;
        (identity as unknown as Record<string, Discovered<string> | undefined>)[slot] = {
          value: token.value,
          source: src.path,
        };
        break;
      }
    }
  }
}

/* ── Type ───────────────────────────────────────────────────────────────── */

/**
 * Font stacks, as declared.
 *
 * The whole stack is kept rather than the first family: it already carries the
 * author's chosen fallbacks, and a renderer that keeps them degrades to
 * something the designer picked instead of to a system default.
 */
export function extractFontStacks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/font-family\s*:\s*([^;{}\n]+)/gi)) {
    const stack = cleanStack(m[1]);
    if (stack) out.push(stack);
  }
  // Tailwind / token modules: fontFamily: { sans: ['Inter', 'system-ui'] }
  for (const m of body.matchAll(/font(?:-|_)?family[^:]{0,20}:\s*\[([^\]]{2,300})\]/gi)) {
    const stack = cleanStack(m[1].replace(/["']/g, ''));
    if (stack) out.push(stack);
  }
  // CSS custom properties holding a stack: --font-heading: 'Archivo', sans-serif
  for (const m of body.matchAll(/(?:--|\$)[a-z0-9_-]*font[a-z0-9_-]*\s*:\s*([^;{}\n]+)/gi)) {
    const stack = cleanStack(m[1]);
    if (stack) out.push(stack);
  }
  return out;
}

function cleanStack(raw: string): string | null {
  const stack = raw
    .replace(/!important/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/["']/g, '')
    .trim()
    .replace(/[,;]$/, '');
  if (!stack || stack.length > 200) return null;
  // `var(--x)` and `inherit` name no family; they are indirection, not a value.
  if (/^(inherit|initial|unset|revert|none)$/i.test(stack)) return null;
  if (/^var\(/i.test(stack)) return null;
  return stack;
}

/** Names that say a stack is for display type rather than running text. */
const HEADING_HINT = /(head|display|title|font-serif|--font-brand)/i;

function assignFonts(
  identity: BrandIdentity,
  sources: { path: string; body: string; rank: number }[],
): void {
  const ranked = [...sources].sort((a, b) => b.rank - a.rank);

  for (const src of ranked) {
    // A declaration whose *name* says "heading" is the strongest signal there is.
    for (const m of src.body.matchAll(
      /(?:--|\$)([a-z0-9_-]*(?:head|display|title)[a-z0-9_-]*)\s*:\s*([^;{}\n]+)/gi,
    )) {
      const stack = cleanStack(m[2]);
      if (stack && !identity.heading_font && HEADING_HINT.test(m[1])) {
        identity.heading_font = { value: stack, source: src.path };
      }
    }

    // `body { font-family: ... }` and `:root { font-family: ... }` are the
    // product's running text by definition.
    for (const m of src.body.matchAll(
      /(?:^|})\s*(?::root|html|body)[^{}]{0,80}\{[^}]{0,2000}?font-family\s*:\s*([^;{}\n]+)/gi,
    )) {
      const stack = cleanStack(m[1]);
      if (stack && !identity.body_font) {
        identity.body_font = { value: stack, source: src.path };
      }
    }
  }

  // Anything left over: the first stack any ranked file declares.
  for (const src of ranked) {
    const stacks = extractFontStacks(src.body);
    for (const stack of stacks) {
      if (!identity.body_font) identity.body_font = { value: stack, source: src.path };
      else if (!identity.heading_font && stack !== identity.body_font.value) {
        identity.heading_font = { value: stack, source: src.path };
      }
    }
  }

  // A product with one typeface uses it for both. That is a real answer, not a
  // gap: leaving heading unresolved would invite a renderer to pick its own.
  if (identity.body_font && !identity.heading_font) {
    identity.heading_font = { ...identity.body_font };
  }
}

/* ── Mark ───────────────────────────────────────────────────────────────── */

const LOGO_RE = /(^|\/)([a-z0-9_-]*(logo|wordmark|brandmark|logotype)[a-z0-9_-]*)\.(svg|png|webp)$/i;
const DARK_RE = /(dark|invert|white|light-on|on-dark)/i;
const ICON_ONLY = /(favicon|apple-touch|android-chrome|maskable|icon-\d)/i;

function assignLogos(
  identity: BrandIdentity,
  ref: RepoRef,
  client: GitHubClient,
  branch: string,
  files: TreeEntry[],
): void {
  const candidates = files
    .filter((f) => LOGO_RE.test(f.path) && !ICON_ONLY.test(f.path) && f.size > 0)
    // SVG first (scales to a 1080px canvas), then the shallowest path: a logo
    // in `public/` is the product's mark, one under `docs/examples/` is not.
    .sort(
      (a, b) =>
        Number(b.path.endsWith('.svg')) - Number(a.path.endsWith('.svg')) ||
        a.path.split('/').length - b.path.split('/').length ||
        a.path.length - b.path.length,
    )
    .slice(0, 6);

  identity.evidence.logo_candidates = candidates.map((f) => ({
    path: f.path,
    url: client.rawUrl(ref, branch, f.path),
  }));

  const light = candidates.find((f) => !DARK_RE.test(f.path));
  const dark = candidates.find((f) => DARK_RE.test(f.path));

  if (light) identity.logo_url = { value: client.rawUrl(ref, branch, light.path), source: light.path };
  if (dark) {
    identity.logo_dark_url = { value: client.rawUrl(ref, branch, dark.path), source: dark.path };
  }
  // A repository shipping only a dark-background mark still has a mark.
  if (!light && dark) {
    identity.logo_url = { value: client.rawUrl(ref, branch, dark.path), source: dark.path };
  }
}
