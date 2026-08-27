/**
 * The FullSend mark.
 *
 * The symbol is a throttle-pushed-forward chevron stack: three chevrons of
 * increasing weight leaning right, the leading one solid electric orange. It
 * reads as a send arrow, a launch, a throttle at its stop, and — because the
 * chevrons sit inside a squared bracket — as an "FS" cut from negative space.
 *
 * Deliberately simple: two colours, no gradients, no strokes below 8 units at a
 * 100-unit grid, so it survives being rendered at 16px.
 */

import { FULLSEND_COLORS } from './fullsend-brand';

export type LogoTone = 'dark' | 'light' | 'mono-white' | 'mono-black' | 'mono-orange';

interface Palette {
  lead: string;
  trail: string;
  wordmark: string;
  wordmarkAccent: string;
  bg: string | null;
}

function palette(tone: LogoTone): Palette {
  switch (tone) {
    case 'dark':
      return {
        lead: FULLSEND_COLORS.orange,
        trail: FULLSEND_COLORS.white,
        wordmark: FULLSEND_COLORS.white,
        wordmarkAccent: FULLSEND_COLORS.orange,
        bg: null,
      };
    case 'light':
      return {
        lead: FULLSEND_COLORS.orange,
        trail: FULLSEND_COLORS.void,
        wordmark: FULLSEND_COLORS.void,
        wordmarkAccent: FULLSEND_COLORS.orange,
        bg: null,
      };
    case 'mono-white':
      return {
        lead: '#FFFFFF',
        trail: '#FFFFFF',
        wordmark: '#FFFFFF',
        wordmarkAccent: '#FFFFFF',
        bg: null,
      };
    case 'mono-black':
      return {
        lead: '#000000',
        trail: '#000000',
        wordmark: '#000000',
        wordmarkAccent: '#000000',
        bg: null,
      };
    case 'mono-orange':
      return {
        lead: FULLSEND_COLORS.orange,
        trail: FULLSEND_COLORS.orange,
        wordmark: FULLSEND_COLORS.orange,
        wordmarkAccent: FULLSEND_COLORS.orange,
        bg: null,
      };
  }
}

/**
 * The symbol on a 100x100 grid. `compact` drops the trailing chevrons to two
 * and fattens them — that is the version used below ~24px and for favicons.
 */
export function fullsendSymbolPaths(tone: LogoTone, compact = false): string {
  const p = palette(tone);

  if (compact) {
    // Two chevrons, heavier, wider gap. Survives 16x16.
    return [
      `<path d="M20 18 L46 50 L20 82 L38 82 L64 50 L38 18 Z" fill="${p.trail}" opacity="0.55"/>`,
      `<path d="M52 18 L78 50 L52 82 L70 82 L96 50 L70 18 Z" fill="${p.lead}"/>`,
    ].join('');
  }

  // Three chevrons: momentum trail into a solid leading edge.
  return [
    `<path d="M6 26 L26 50 L6 74 L18 74 L38 50 L18 26 Z" fill="${p.trail}" opacity="0.30"/>`,
    `<path d="M33 20 L58 50 L33 80 L49 80 L74 50 L49 20 Z" fill="${p.trail}" opacity="0.62"/>`,
    `<path d="M64 14 L94 50 L64 86 L84 86 L114 50 L84 14 Z" fill="${p.lead}"/>`,
  ].join('');
}

/** Icon-only lockup. Square, safe-area padded, optional filled ground. */
export function fullsendIconSvg(opts: {
  size?: number;
  tone?: LogoTone;
  background?: string | null;
  rounded?: boolean;
  compact?: boolean;
} = {}): string {
  const { size = 512, tone = 'dark', background = null, rounded = true, compact = false } = opts;
  const r = rounded ? 26 : 0;
  const ground = background
    ? `<rect width="120" height="120" rx="${r}" fill="${background}"/>`
    : '';
  // Symbol grid is 120 wide to give the leading chevron room to break right.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}" role="img" aria-label="FullSend">
<title>FullSend</title>
${ground}<g transform="translate(2 10)">${fullsendSymbolPaths(tone, compact)}</g>
</svg>`;
}

/**
 * The wordmark, drawn as paths so it needs no font at render time. Heavy
 * geometric grotesque, tight tracking, "Full" in the wordmark colour and "Send"
 * carrying the accent — the name literally sends.
 */
function wordmarkPaths(fill: string, accent: string): string {
  // Letterforms on a 26-unit cap height baseline at y=0..26, drawn with
  // rectangles and notches. Simple by design; renders identically everywhere.
  const bar = (x: number, y: number, w: number, h: number, f: string) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"/>`;

  const F = (x: number, f: string) =>
    bar(x, 0, 5, 26, f) + bar(x + 5, 0, 12, 5, f) + bar(x + 5, 10.5, 10, 5, f);
  const U = (x: number, f: string) =>
    bar(x, 0, 5, 21, f) + bar(x + 12, 0, 5, 21, f) + bar(x, 21, 17, 5, f);
  const L = (x: number, f: string) => bar(x, 0, 5, 26, f) + bar(x + 5, 21, 11, 5, f);
  const S = (x: number, f: string) =>
    bar(x, 0, 17, 5, f) +
    bar(x, 5, 5, 6, f) +
    bar(x, 10.5, 17, 5, f) +
    bar(x + 12, 15.5, 5, 6, f) +
    bar(x, 21, 17, 5, f);
  const E = (x: number, f: string) =>
    bar(x, 0, 5, 26, f) + bar(x + 5, 0, 12, 5, f) + bar(x + 5, 10.5, 10, 5, f) + bar(x + 5, 21, 12, 5, f);
  const N = (x: number, f: string) =>
    bar(x, 0, 5, 26, f) +
    bar(x + 12, 0, 5, 26, f) +
    `<path d="M${x + 5} 0 L${x + 12} 0 L${x + 12} 26 L${x + 5} 26 Z" fill="${f}" opacity="0"/>` +
    `<path d="M${x + 5} 0 L${x + 12} 17 L${x + 12} 26 L${x + 5} 9 Z" fill="${f}"/>`;
  const D = (x: number, f: string) =>
    bar(x, 0, 5, 26, f) +
    bar(x + 5, 0, 8, 5, f) +
    bar(x + 5, 21, 8, 5, f) +
    bar(x + 12, 3, 5, 20, f) +
    `<path d="M${x + 12} 2 L${x + 17} 6 L${x + 17} 3 Z" fill="${f}"/>`;

  const g = 4; // letter gap
  let x = 0;
  const out: string[] = [];
  // F u l l
  out.push(F(x, fill)); x += 17 + g;
  out.push(U(x, fill)); x += 17 + g;
  out.push(L(x, fill)); x += 16 + g;
  out.push(L(x, fill)); x += 16 + g + 4;
  // S e n d — accented
  out.push(S(x, accent)); x += 17 + g;
  out.push(E(x, accent)); x += 17 + g;
  out.push(N(x, accent)); x += 17 + g;
  out.push(D(x, accent));
  return out.join('');
}

/** Full horizontal lockup: symbol + wordmark. */
export function fullsendLockupSvg(opts: {
  width?: number;
  tone?: LogoTone;
  background?: string | null;
} = {}): string {
  const { width = 900, tone = 'dark', background = null } = opts;
  const p = palette(tone);
  const vbW = 480;
  const vbH = 120;
  const height = Math.round((width * vbH) / vbW);
  const ground = background ? `<rect width="${vbW}" height="${vbH}" fill="${background}"/>` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW} ${vbH}" width="${width}" height="${height}" role="img" aria-label="FullSend">
<title>FullSend</title>
${ground}<g transform="translate(8 12)">${fullsendSymbolPaths(tone, false)}</g>
<g transform="translate(150 34) scale(1.62)">${wordmarkPaths(p.wordmark, p.wordmarkAccent)}</g>
</svg>`;
}

/** Social profile image: square, dark ground, centred compact symbol. */
export function fullsendSocialAvatarSvg(size = 1024): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" role="img" aria-label="FullSend">
<title>FullSend</title>
<rect width="512" height="512" fill="${FULLSEND_COLORS.void}"/>
<rect x="0" y="0" width="512" height="512" fill="url(#fsGlow)"/>
<defs>
  <radialGradient id="fsGlow" cx="0.5" cy="0.38" r="0.72">
    <stop offset="0%" stop-color="${FULLSEND_COLORS.orange}" stop-opacity="0.20"/>
    <stop offset="100%" stop-color="${FULLSEND_COLORS.orange}" stop-opacity="0"/>
  </radialGradient>
</defs>
<g transform="translate(96 96) scale(2.66)">${fullsendSymbolPaths('dark', true)}</g>
</svg>`;
}

/** Favicon: the compact symbol, no safe area, maximum optical weight. */
export function fullsendFaviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="32" height="32">
<rect width="100" height="100" rx="18" fill="${FULLSEND_COLORS.void}"/>
<g transform="translate(0 0) scale(1)">${fullsendSymbolPaths('dark', true)}</g>
</svg>`;
}

/** App icon: rounded square, dark ground, orange-forward compact symbol. */
/**
 * The home-screen icon.
 *
 * `maskable` drops the rounded corners and fills the square edge to edge.
 * Android crops an adaptive icon to whatever shape the launcher uses, so an
 * icon that rounds its own corners gets rounded twice and shows bare gaps at
 * the sides. The mark sits well inside the middle 80% either way, which is the
 * region every mask is guaranteed to keep.
 */
export function fullsendAppIconSvg(size = 1024, opts: { maskable?: boolean } = {}): string {
  const corner = opts.maskable ? 0 : 114;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" role="img" aria-label="FullSend">
<title>FullSend</title>
<defs>
  <linearGradient id="fsIconBg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${FULLSEND_COLORS.charcoal}"/>
    <stop offset="100%" stop-color="${FULLSEND_COLORS.void}"/>
  </linearGradient>
</defs>
<rect width="512" height="512" rx="${corner}" fill="url(#fsIconBg)"/>
<g transform="translate(102 102) scale(3.08)">${fullsendSymbolPaths('dark', true)}</g>
</svg>`;
}
