/**
 * Brand discovery — reading a product's visual identity out of its repository.
 *
 * A repository that ships a UI has already decided what it looks like. Its
 * colours are in a stylesheet, a web manifest or an app config; its type is in
 * a font import; its mark is an image in `public/`. Those are facts about the
 * product, sitting in version control, and asking a language model to imagine a
 * brand for a product that already has one is both wasteful and wrong.
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
 * **Where it used to stop looking.** This read `.css`/`.scss`/`.less` and a
 * Tailwind config, and nothing else. A great many products state their brand
 * nowhere near a stylesheet: a PWA puts it in `manifest.webmanifest`, whose
 * `theme_color` field exists for no other purpose; a Capacitor or Expo app puts
 * it in `capacitor.config.json` or `app.json`; a self-contained HTML app puts
 * the whole design system in one `<style>` block and a `<meta name="theme-color">`.
 * Such a repository states its brand four times over and discovery reported
 * "not found in the repository" for every field — which then renders every post
 * in the neutral palette, so the posts do not look like the product. The
 * ranking below reads all of those, and `sourceRank` no longer advertises
 * theme and token modules that the file filter then refused to open.
 *
 * Ordering is the whole trick. A repository states its colours several times
 * over and these disagree, so every candidate carries the rank of the thing
 * that declared it and the highest rank wins the slot. Rank is about how
 * deliberate a declaration is, not how often a value appears: `theme_color` in
 * a manifest is the brand by definition, and a `#ffffff` appearing ninety times
 * is not. One deliberate exception is documented at `accentFromUsage`.
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
 * The cap exists because ingestion is on the critical path of an analysis and a
 * monorepo can carry hundreds of stylesheets. Files chosen by rank beat files
 * chosen by walking the tree, so a modest cap costs nothing — but it is higher
 * than the original eight, because a manifest and an HTML entry point are now
 * in the running and they must not be crowded out by component stylesheets.
 */
const MAX_SOURCE_FILES = 16;
const MAX_FILE_BYTES = 400_000;

type SourceKind = 'css' | 'tokens' | 'tailwind' | 'manifest' | 'html';

interface Source {
  path: string;
  body: string;
  rank: number;
  kind: SourceKind;
}

const STYLE_RE = /\.(css|scss|sass|less)$/i;
const TAILWIND_RE = /(^|\/)tailwind\.config\.[cm]?[jt]s$/i;
/**
 * Theme and token modules. `sourceRank` has always ranked these highest and the
 * file filter has never opened one, so a product whose palette lives in
 * `theme.ts` — the single most common place to put it outside CSS — read as a
 * product with no palette.
 */
const TOKENS_RE =
  /(^|\/)(theme|themes|tokens?|design-tokens?|palette|colou?rs?|brand|branding)\.(ts|tsx|js|jsx|mjs|cjs|json|xml)$/i;
/**
 * Manifests and app configs. `theme_color` exists solely to state the brand
 * colour; `appName` solely to state the brand name. Nothing in a repository is
 * more deliberate than a field whose only purpose is the answer.
 */
const MANIFEST_RE =
  /(^|\/)(manifest\.webmanifest|manifest\.json|site\.webmanifest|app\.json|app\.config\.(?:json|[cm]?[jt]s)|capacitor\.config\.(?:json|[cm]?[jt]s)|expo\.json)$/i;
/** A self-contained HTML app keeps its design system inline. */
const HTML_RE = /(^|\/)(index|app|main|home)\.html$/i;

const SKIP_STYLE =
  /(node_modules|\.min\.css$|vendor|bootstrap|normalize\.css$|reset\.css$|tailwind\.css$|font-?awesome)/i;
/** Build output and dependency copies restate someone else's brand, not yours. */
const SKIP_ANY = /(^|\/)(node_modules|dist|build|out|\.next|coverage|vendor)\//i;

/**
 * How much a file's word is worth, high to low.
 *
 * A manifest or a token file exists to state the brand, so they win. A Tailwind
 * config states it too, but is also full of plugin and spacing noise. A global
 * stylesheet — or the inline `<style>` of a single-page app, which is the same
 * thing — is usually right. A component stylesheet is a local decision that
 * happens to contain colours.
 */
function sourceRank(path: string): number {
  const p = path.toLowerCase();
  if (MANIFEST_RE.test(p)) return 5;
  if (TOKENS_RE.test(p)) return 5;
  if (TAILWIND_RE.test(p)) return 4;
  if (HTML_RE.test(p)) return 3;
  if (/(^|\/)(globals?|app|index|main|style|styles)\.(css|scss|sass|less)$/.test(p)) return 3;
  if (STYLE_RE.test(p)) return 2;
  return 1;
}

function kindOf(path: string): SourceKind {
  if (MANIFEST_RE.test(path)) return 'manifest';
  if (HTML_RE.test(path)) return 'html';
  if (TAILWIND_RE.test(path)) return 'tailwind';
  if (TOKENS_RE.test(path)) return 'tokens';
  return 'css';
}

/**
 * Reads a repository's visual identity.
 *
 * Best effort throughout: a repository with no stylesheet, a private file that
 * 404s, or a tree that was truncated all produce a partial result with the gaps
 * named in `evidence.unresolved`. Discovery must never be able to fail an
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

  const wanted = files
    .filter((f) => {
      if (f.size <= 0 || f.size >= MAX_FILE_BYTES) return false;
      if (SKIP_ANY.test(f.path)) return false;
      if (MANIFEST_RE.test(f.path) || TOKENS_RE.test(f.path) || TAILWIND_RE.test(f.path)) {
        return true;
      }
      if (HTML_RE.test(f.path)) return f.path.split('/').length <= 3;
      return STYLE_RE.test(f.path) && !SKIP_STYLE.test(f.path);
    })
    .sort((a, b) => sourceRank(b.path) - sourceRank(a.path) || a.path.length - b.path.length)
    .slice(0, MAX_SOURCE_FILES);

  const sources: Source[] = [];
  for (const file of wanted) {
    const body = await client.getFile(ref, file.path, branch).catch(() => null);
    if (!body) continue;
    sources.push({
      path: file.path,
      body,
      rank: sourceRank(file.path),
      kind: kindOf(file.path),
    });
    identity.evidence.style_files.push(file.path);
  }

  /*
   * An HTML entry point is two sources wearing one filename: its `<style>`
   * blocks are a stylesheet, and its `<meta>` and `<title>` are declarations of
   * their own. Splitting it here means every CSS parser below works on it
   * unchanged, rather than each one learning about HTML.
   */
  const cssLike: Source[] = sources.flatMap((src) =>
    src.kind === 'html'
      ? inlineStyles(src.body).map((body) => ({ ...src, body, kind: 'css' as const }))
      : src.kind === 'manifest'
        ? []
        : [src],
  );

  for (const src of cssLike) {
    identity.evidence.color_tokens.push(
      ...extractColorTokens(src.body).map((t) => ({ ...t, source: src.path })),
    );
    identity.evidence.font_families.push(
      ...extractFontStacks(src.body).map((value) => ({ value, source: src.path })),
    );
  }
  for (const src of sources.filter((s) => s.kind === 'manifest')) {
    identity.evidence.color_tokens.push(
      ...manifestColors(src.body).map((c) => ({ name: c.name, value: c.value, source: src.path })),
    );
  }

  assignColors(identity, sources, cssLike);
  assignFonts(identity, cssLike);
  assignBrandName(identity, sources);
  assignLogos(identity, ref, client, branch, files);

  for (const field of [
    'brand_name',
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

/* ── HTML ───────────────────────────────────────────────────────────────── */

/** The contents of every `<style>` block, which is CSS by any other name. */
export function inlineStyles(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const body = m[1].trim();
    if (body) out.push(body);
  }
  return out;
}

/** `<meta name="theme-color" content="#0E2B20">`, in either attribute order. */
export function metaThemeColor(html: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/name\s*=\s*["']?theme-color["']?/i.test(tag)) continue;
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(tag);
    const hex = content ? normaliseColor(content[1]) : null;
    if (hex) return hex;
  }
  return null;
}

/** The document title, minus whatever tagline follows a dash or a pipe. */
export function titleBrand(html: string): string | null {
  const m = /<title\b[^>]*>([\s\S]{1,200}?)<\/title>/i.exec(html);
  if (!m) return null;
  const name = m[1]
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+[—–|·:]\s+/)[0]
    .trim();
  return name && name.length <= 60 ? name : null;
}

/* ── Manifests and app configs ──────────────────────────────────────────── */

/**
 * The colour fields a manifest or app config declares, named by the slot they
 * fill. Parsed as JSON when it is JSON, and by pattern when it is a JS config —
 * an `app.config.ts` is a module this cannot execute, but the field it declares
 * is still written as `backgroundColor: '#0E2B20'`.
 */
export function manifestColors(body: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const push = (name: string, raw: unknown) => {
    if (typeof raw !== 'string') return;
    const hex = normaliseColor(raw);
    if (hex) out.push({ name, value: hex });
  };

  const json = parseJsonish(body);
  if (json) {
    const expo = (isRecord(json.expo) ? json.expo : json) as Record<string, unknown>;
    push('theme_color', expo.theme_color ?? expo.themeColor);
    push('primary_color', expo.primary_color ?? expo.primaryColor);
    push('background_color', expo.background_color ?? expo.backgroundColor);
    const splash = isRecord(expo.splash) ? expo.splash : null;
    if (splash) push('background_color', splash.backgroundColor ?? splash.background_color);
    const android = isRecord(expo.android) ? expo.android : null;
    const adaptive = android && isRecord(android.adaptiveIcon) ? android.adaptiveIcon : null;
    if (adaptive) push('background_color', adaptive.backgroundColor);
    return out;
  }

  for (const m of body.matchAll(
    /["']?(theme_?color|primary_?color|background_?color)["']?\s*:\s*["']([^"']+)["']/gi,
  )) {
    push(m[1].toLowerCase().replace(/([a-z])color/i, '$1_color').replace('__', '_'), m[2]);
  }
  return out;
}

/** The brand name a manifest or app config declares, most specific first. */
export function manifestBrandName(body: string): string | null {
  const json = parseJsonish(body);
  if (json) {
    const expo = (isRecord(json.expo) ? json.expo : json) as Record<string, unknown>;
    for (const key of ['short_name', 'shortName', 'appName', 'displayName', 'name'] as const) {
      const value = expo[key];
      if (typeof value === 'string') {
        const name = cleanBrandName(value);
        if (name) return name;
      }
    }
    return null;
  }
  const m = /["']?(?:shortName|appName|displayName|name)["']?\s*:\s*["']([^"']{1,80})["']/.exec(
    body,
  );
  return m ? cleanBrandName(m[1]) : null;
}

/**
 * A product name, without the tagline a manifest often appends.
 *
 * `"PlayPal — Golf Companion"` is a `name`; `PlayPal` is the brand. A package
 * slug (`my-app`) is deliberately left alone rather than title-cased: inventing
 * capitalisation is the kind of confident guess this module refuses to make.
 */
function cleanBrandName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim().split(/\s+[—–|·:]\s+/)[0].trim();
  if (!name || name.length > 60) return null;
  if (/^[@./]/.test(name)) return null; // an npm scope is not a brand
  return name;
}

function parseJsonish(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ── Colour ─────────────────────────────────────────────────────────────── */

/**
 * `#abc`, `#abcd`, `#aabbcc`, `#aabbccdd`.
 *
 * Longest form first, and followed by a lookahead that refuses a trailing hex
 * digit. Regex alternation is ordered rather than greedy, so a shorter branch
 * placed first wins on a longer input: with `{3,4}` leading, `#F6F4EE` matched
 * as `#F6F4`, which then normalised as a four-digit shorthand and came back as
 * `#ff66ff`. A bone-white background read as magenta, from a parser that looked
 * like it was working.
 */
const HEX = '#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-fA-F])';
/** `rgb(14 43 32)`, `rgba(14,43,32,.5)`, `hsl(158 51% 11%)` — and bare triples. */
const FUNC = '(?:rgba?|hsla?)\\([^)]{3,80}\\)';
const COLOR = `(?:${HEX}|${FUNC})`;

/**
 * Named colour declarations: CSS custom properties, SCSS/Less variables, and
 * the `key: '#hex'` pairs a Tailwind config or a token module is written as.
 *
 * The name is what makes a colour usable — `--brand-primary` says which slot it
 * fills, where a loose hex in a gradient says nothing. Values that are
 * references to other variables are skipped rather than resolved: one level of
 * indirection is common and cheap to follow, but a chain is where a parser
 * starts inventing, and a wrong colour presented confidently is the failure
 * this module exists to prevent.
 *
 * `rgb()` and `hsl()` are read as well as hex. A theme written in either — and
 * a shadcn/ui theme, which writes bare `H S% L%` triples with no function
 * wrapper at all — used to produce no tokens whatsoever.
 */
export function extractColorTokens(body: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const push = (name: string, value: string) => {
    const hex = normaliseColor(value);
    if (hex) out.push({ name: name.toLowerCase(), value: hex });
  };

  // --brand-primary: #ff5a1f;  $brand-primary: rgb(255 90 31);  @primary: ...
  for (const m of body.matchAll(
    new RegExp(`(?:--|\\$|@)([a-zA-Z0-9_-]{2,60})\\s*:\\s*(${COLOR})`, 'g'),
  )) {
    push(m[1], m[2]);
  }

  // shadcn/ui and friends: `--primary: 221.2 83.2% 53.3%` — an hsl() body with
  // the function left off, because Tailwind wraps it back up at use site.
  for (const m of body.matchAll(
    /(?:--)([a-zA-Z0-9_-]{2,60})\s*:\s*(\d{1,3}(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?%\s+\d{1,3}(?:\.\d+)?%)\s*[;}]/g,
  )) {
    push(m[1], `hsl(${m[2]})`);
  }

  // primary: '#ff5a1f'  /  "primary": "#ff5a1f"  — Tailwind configs, token modules.
  for (const m of body.matchAll(
    new RegExp(`["']?([a-zA-Z0-9_-]{2,60})["']?\\s*:\\s*["'](${COLOR})["']`, 'g'),
  )) {
    push(m[1], m[2]);
  }

  return out;
}

/**
 * Any colour form this module understands, as `#rrggbb`.
 *
 * Everything downstream — contrast checks, SVG fills, the stored profile —
 * assumes six-digit hex, so conversion happens once, here, at the parse
 * boundary rather than at each use.
 */
export function normaliseColor(raw: string): string | null {
  const value = raw.trim();

  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(value);
  if (hex) {
    let h = hex[1].toLowerCase();
    if (h.length === 4) h = h.slice(0, 3); // #rgba -> #rgb, alpha is not brand
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return h.length === 6 ? `#${h}` : null;
  }

  const fn = /^(rgba?|hsla?)\(([^)]+)\)$/i.exec(value);
  if (!fn) return null;
  const parts = fn[2]
    .split(/[\s,/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;

  if (/^rgba?$/i.test(fn[1])) {
    const [r, g, b] = parts.slice(0, 3).map((p) => channel(p, 255));
    if ([r, g, b].some((c) => c === null)) return null;
    return rgbHex(r as number, g as number, b as number);
  }

  const h = Number.parseFloat(parts[0]);
  const s = Number.parseFloat(parts[1]) / 100;
  const l = Number.parseFloat(parts[2]) / 100;
  if (![h, s, l].every(Number.isFinite)) return null;
  return hslHex(h, clamp01(s), clamp01(l));
}

function channel(raw: string, max: number): number | null {
  const pct = raw.endsWith('%');
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  const v = pct ? (n / 100) * max : n;
  return Math.max(0, Math.min(max, Math.round(v)));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function hslHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const m = l - c / 2;
  return rgbHex(
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  );
}

/*
 * What a token's name says about the slot it fills.
 *
 * Ordered because names overlap: `--primary-foreground` is a text colour that
 * contains the word "primary", and matching "primary" first would make it the
 * brand colour. Foreground and background are therefore tested before accent
 * and primary, and every pattern that could collide is anchored.
 */
const SLOT_PATTERNS: { slot: ColorSlot; re: RegExp }[] = [
  { slot: 'background_color', re: /^(--)?(color-)?(bg|background|surface|canvas|base)(-color)?$/ },
  { slot: 'background_color', re: /(^|-|_)(background|bg)(-(default|base|primary|body|page))?$/ },
  { slot: 'text_color', re: /^(--)?(color-)?(fg|foreground|text|ink|copy|body-text)(-color)?$/ },
  { slot: 'text_color', re: /(^|-)(foreground|text)(-(default|base|primary|body))?$/ },
  { slot: 'accent_color', re: /(^|-)(accent|highlight)(-color)?$/ },
  { slot: 'secondary_color', re: /(^|-)(secondary|brand-secondary)(-color)?$/ },
  { slot: 'primary_color', re: /^(theme_color)$/ },
  { slot: 'primary_color', re: /(^|-|_)(brand|primary|brand-primary|main)(-color)?$/ },
];

type ColorSlot =
  | 'primary_color'
  | 'secondary_color'
  | 'accent_color'
  | 'background_color'
  | 'text_color';

interface Candidate {
  slot: ColorSlot;
  value: string;
  source: string;
  rank: number;
}

/**
 * The bare `background:` and `color:` of the document's own root rule.
 *
 * A great many products never name a colour token at all: they write
 * `html, body { background: #F6F4EE; color: #0E2B20 }` once and style
 * everything else from there. Those two declarations are the page's ground and
 * its ink by definition, which is exactly what the background and text slots
 * want, and reading only *named* tokens made them invisible.
 */
export function rootColors(body: string): { slot: ColorSlot; value: string }[] {
  const out: { slot: ColorSlot; value: string }[] = [];
  for (const rule of body.matchAll(
    /(?:^|[};])\s*((?::root|html|body)(?:\s*,\s*(?::root|html|body))*)\s*\{([^}]{0,3000})\}/gi,
  )) {
    const block = rule[2];
    const bg = new RegExp(`(?:^|[;{\\s])background(?:-color)?\\s*:\\s*(${COLOR})`, 'i').exec(block);
    const fg = new RegExp(`(?:^|[;{\\s])color\\s*:\\s*(${COLOR})`, 'i').exec(block);
    const bgHex = bg ? normaliseColor(bg[1]) : null;
    const fgHex = fg ? normaliseColor(fg[1]) : null;
    if (bgHex) out.push({ slot: 'background_color', value: bgHex });
    if (fgHex) out.push({ slot: 'text_color', value: fgHex });
  }
  return out;
}

function assignColors(identity: BrandIdentity, sources: Source[], cssLike: Source[]): void {
  const candidates: Candidate[] = [];

  for (const src of sources) {
    if (src.kind !== 'manifest') continue;
    for (const { name, value } of manifestColors(src.body)) {
      /*
       * A manifest's `background_color` is its *splash* colour, not the
       * product's page ground — PlayPal's is the dark green behind the launch
       * screen while the app itself is bone white. It is still evidence, so it
       * is kept, but ranked below any stylesheet that states a real background.
       */
      const rank = name === 'background_color' ? 2 : src.rank;
      const slot = slotFor(name);
      if (slot) candidates.push({ slot, value, source: src.path, rank });
    }
  }

  for (const src of sources) {
    if (src.kind !== 'html') continue;
    const theme = metaThemeColor(src.body);
    // `<meta name="theme-color">` has exactly one purpose, so it outranks the
    // stylesheet that happens to sit in the same file.
    if (theme) candidates.push({ slot: 'primary_color', value: theme, source: src.path, rank: 5 });
  }

  for (const src of cssLike) {
    for (const token of extractColorTokens(src.body)) {
      const slot = slotFor(token.name);
      // A token file naming a slot is deliberate; a component file is not.
      if (slot && src.rank >= 2) {
        candidates.push({ slot, value: token.value, source: src.path, rank: src.rank });
      }
    }
    for (const { slot, value } of rootColors(src.body)) {
      candidates.push({ slot, value, source: src.path, rank: src.rank });
    }
  }

  // Highest rank wins a slot; ties go to whichever was declared first, so the
  // first thing a theme file says about a slot still wins.
  for (const candidate of [...candidates].sort((a, b) => b.rank - a.rank)) {
    if (identity[candidate.slot]) continue;
    identity[candidate.slot] = { value: candidate.value, source: candidate.source };
  }

  accentFromUsage(identity, cssLike);
}

function slotFor(name: string): ColorSlot | null {
  for (const { slot, re } of SLOT_PATTERNS) {
    if (re.test(name)) return slot;
  }
  return null;
}

/**
 * The accent slot, from the colour the product actually decorates with.
 *
 * This is the one inference in the module, and it is bounded on every side. A
 * product very often has a second colour it uses everywhere — PlayPal's gold
 * sits in its focus ring, its join code and its logo halo — and names it
 * nowhere, because it never needed a token to reach for it. Leaving accent
 * empty in that case is not neutral: `paletteFor` then falls back to near-black
 * and the post loses the one colour a reader would recognise.
 *
 * What keeps it honest: only the accent slot, which is decorative and never
 * carries text on its own; only a chromatic colour, so greys and off-whites
 * cannot win; only a colour the repository uses at least twice, so a one-off in
 * a gradient cannot; never a colour already holding another slot; and the file
 * it came from is recorded like any other reading, so the founder sees the
 * claim and can overrule it.
 */
function accentFromUsage(identity: BrandIdentity, cssLike: Source[]): void {
  if (identity.accent_color) return;

  const taken = new Set(
    [
      identity.primary_color?.value,
      identity.secondary_color?.value,
      identity.background_color?.value,
      identity.text_color?.value,
    ].filter(Boolean) as string[],
  );

  const counts = new Map<string, { count: number; source: string }>();
  for (const src of [...cssLike].sort((a, b) => b.rank - a.rank)) {
    if (src.rank < 2) continue;
    for (const m of src.body.matchAll(new RegExp(COLOR, 'g'))) {
      const hex = normaliseColor(m[0]);
      if (!hex || taken.has(hex) || !isChromatic(hex)) continue;
      const seen = counts.get(hex);
      if (seen) seen.count += 1;
      else counts.set(hex, { count: 1, source: src.path });
    }
  }

  let best: { hex: string; count: number; source: string } | null = null;
  for (const [hex, { count, source }] of counts) {
    if (count < 2) continue;
    if (!best || count > best.count) best = { hex, count, source };
  }
  if (best) identity.accent_color = { value: best.hex, source: best.source };
}

/** Saturated enough to read as a colour rather than as a shade of grey. */
function isChromatic(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return false;
  const saturation = (max - min) / max;
  const lightness = max / 255;
  return saturation >= 0.25 && lightness >= 0.15 && lightness <= 0.97;
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

/**
 * The families a repository bundles as `@font-face`.
 *
 * A product that has committed the woff2 into version control has settled the
 * question of what it is set in — there is no stronger evidence of a typeface
 * than shipping it.
 */
export function extractFontFaces(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/@font-face\s*\{([^}]{0,600})\}/gi)) {
    const family = /font-family\s*:\s*([^;{}\n]+)/i.exec(m[1]);
    const stack = family ? cleanStack(family[1]) : null;
    if (stack && !out.includes(stack)) out.push(stack);
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

function assignFonts(identity: BrandIdentity, cssLike: Source[]): void {
  const ranked = [...cssLike].sort((a, b) => b.rank - a.rank);

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
      /(?:^|})\s*(?::root|html|body)[^{}]{0,80}\{[^}]{0,3000}?font-family\s*:\s*([^;{}\n]+)/gi,
    )) {
      const stack = cleanStack(m[1]);
      if (stack && !identity.body_font) {
        identity.body_font = { value: stack, source: src.path };
      }
    }
  }

  // A bundled family, before falling back to any stack at all.
  for (const src of ranked) {
    for (const family of extractFontFaces(src.body)) {
      if (!identity.body_font) identity.body_font = { value: family, source: src.path };
    }
  }

  // Anything left over: the first stack any ranked file declares.
  for (const src of ranked) {
    for (const stack of extractFontStacks(src.body)) {
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

/* ── Name ───────────────────────────────────────────────────────────────── */

/**
 * The product's name as it writes it.
 *
 * `brand_name` has been in this interface, and in the columns `identityPatch`
 * writes, since the module existed — and nothing ever assigned it, so every
 * project in every database reported its brand name as not found. A manifest's
 * `short_name` and an app config's `appName` are the product's own answer; the
 * document title is the same answer with a tagline attached.
 *
 * The repository's own directory name is deliberately not used. It is a slug,
 * and turning `playpal` into a capitalisation the product never chose is the
 * confident guess the top of this file refuses to make.
 */
function assignBrandName(identity: BrandIdentity, sources: Source[]): void {
  for (const src of sources) {
    if (src.kind !== 'manifest') continue;
    const name = manifestBrandName(src.body);
    if (name && !identity.brand_name) identity.brand_name = { value: name, source: src.path };
  }
  if (identity.brand_name) return;

  for (const src of sources) {
    if (src.kind !== 'html') continue;
    const name = titleBrand(src.body);
    if (name) {
      identity.brand_name = { value: name, source: src.path };
      return;
    }
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
