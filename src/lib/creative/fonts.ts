/**
 * Fonts for server-side rasterisation.
 *
 * This module exists because of a specific production failure, and the failure
 * is worth stating plainly: **every generated post was published and previewed
 * as a blank card.**
 *
 * Creative is typeset as SVG and rasterised with sharp, which draws text
 * through librsvg → pango → fontconfig. Fontconfig can only use fonts that are
 * installed on the machine doing the drawing. A serverless runtime has none —
 * no `/usr/share/fonts`, nothing. So every `<text>` element came out as either
 * nothing at all or a row of tiny tofu boxes, while the rectangles, gradients
 * and rules drew perfectly. The result was a card with a brand-coloured bar, a
 * brand-coloured rule, and no words: structurally valid, visually empty, and
 * indistinguishable from success to every check downstream. It was then stored
 * on the asset, so the blank raster became the preview *and* the media
 * Instagram would fetch.
 *
 * Two things fix it, and both are needed:
 *
 *  1. **Ship the font.** A copy of Inter travels with the application in
 *     `assets/fonts`, and a fontconfig configuration pointing at it is written
 *     before the first raster. Nothing then depends on what the host happens
 *     to have installed.
 *
 *  2. **Prove it works, once, before drawing anything.** `assertTextRenderable`
 *     rasterises a known string and measures how much ink landed. Text that
 *     renders covers a sixth of the probe; tofu covers half a percent. The gap
 *     is not marginal, so the check is decisive — and a deployment that cannot
 *     draw text now fails loudly with a remedy instead of quietly publishing
 *     empty images.
 */
import 'server-only';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { FullSendError } from '../errors';
import { logger } from '../logger';
import { BUNDLED_FONT_FAMILY } from './font-constants';

const log = logger('creative.fonts');

/**
 * The family bundled with the application.
 *
 * Every card asks for the *brand's* font stack first; this is the last real
 * family before the generic keyword, so a product whose own typeface is not
 * installed here still gets typeset in something deliberate rather than in
 * whatever fontconfig picks off the floor.
 */
export { BUNDLED_FONT_FAMILY } from './font-constants';

/** Where the vendored faces live, relative to the application root. */
const VENDORED_DIR = path.join('assets', 'fonts');

/** System directories kept in the configuration when the host has them. */
const SYSTEM_FONT_DIRS = [
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  '/System/Library/Fonts',
  '/Library/Fonts',
];

export interface FontSetup {
  /** Directory the bundled faces were found in, or null if they are missing. */
  directory: string | null;
  /** The fontconfig file written for this process, if one was written. */
  configPath: string | null;
  /** True when an operator's own FONTCONFIG_FILE was left alone. */
  operatorManaged: boolean;
}

let setup: FontSetup | null = null;

/** Candidate locations for the bundled faces, best first. */
function candidateDirectories(): string[] {
  const explicit = process.env.FULLSEND_FONT_DIR?.trim();
  const roots = [
    ...(explicit ? [explicit] : []),
    path.join(process.cwd(), VENDORED_DIR),
    // Next traces server files into `.next/server`; a build that resolves the
    // application root differently still finds the copy beside it.
    path.join(process.cwd(), '.next', 'server', VENDORED_DIR),
    path.join(process.cwd(), '..', VENDORED_DIR),
  ];
  return roots;
}

export function fontDirectory(): string | null {
  for (const dir of candidateDirectories()) {
    if (existsSync(path.join(dir, 'Inter-Regular.ttf'))) return dir;
  }
  return null;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderFontConfig(fontDir: string, cacheDir: string): string {
  const dirs = [fontDir, ...SYSTEM_FONT_DIRS.filter((d) => existsSync(d))]
    .map((d) => `  <dir>${xmlEscape(d)}</dir>`)
    .join('\n');

  /*
   * `binding="same"` on the aliases rather than `strong`: a brand that really
   * does ship its own typeface, on a host that really does have it installed,
   * must keep it. These only decide what happens when the requested family is
   * not there — which, on a serverless host, is every family.
   */
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
${dirs}
  <cachedir>${xmlEscape(cacheDir)}</cachedir>
  <include ignore_missing="yes">/etc/fonts/conf.d</include>
  <alias binding="same"><family>sans-serif</family><prefer><family>${BUNDLED_FONT_FAMILY}</family></prefer></alias>
  <alias binding="same"><family>system-ui</family><prefer><family>${BUNDLED_FONT_FAMILY}</family></prefer></alias>
  <alias binding="same"><family>ui-sans-serif</family><prefer><family>${BUNDLED_FONT_FAMILY}</family></prefer></alias>
</fontconfig>
`;
}

/**
 * Points fontconfig at the bundled faces. Idempotent, and safe to call on
 * every raster.
 *
 * Fontconfig reads its configuration once, on first use, so this has to run
 * before anything draws text — which is why `rasterize` calls it rather than
 * trusting module import order.
 */
export function ensureFontsConfigured(): FontSetup {
  if (setup) return setup;

  // An operator who has set this up themselves has said what they want.
  if (process.env.FONTCONFIG_FILE?.trim()) {
    setup = { directory: fontDirectory(), configPath: null, operatorManaged: true };
    return setup;
  }

  const directory = fontDirectory();
  if (!directory) {
    log.error('bundled fonts are missing', { searched: candidateDirectories() });
    setup = { directory: null, configPath: null, operatorManaged: false };
    return setup;
  }

  const base = path.join(os.tmpdir(), 'fullsend-fontconfig');
  const cacheDir = path.join(base, 'cache');
  const configPath = path.join(base, 'fonts.conf');
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(configPath, renderFontConfig(directory, cacheDir), 'utf8');
    process.env.FONTCONFIG_FILE = configPath;
    process.env.FONTCONFIG_PATH = base;
    setup = { directory, configPath, operatorManaged: false };
    log.info('font configuration written', { directory, configPath });
  } catch (e) {
    // A read-only temp directory is survivable on a host that has its own
    // fonts; the probe below is what decides whether it actually is.
    log.warn('could not write a font configuration', { error: String(e) });
    setup = { directory, configPath: null, operatorManaged: false };
  }
  return setup;
}

/* ── Proving text can actually be drawn ─────────────────────────────────── */

/**
 * A string with no descenders and no ambiguity, drawn heavy and large so the
 * measurement is about the font rather than about the glyphs.
 */
const PROBE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="96" viewBox="0 0 240 96"><rect width="240" height="96" fill="#ffffff"/><text x="8" y="72" font-family="${BUNDLED_FONT_FAMILY}, sans-serif" font-size="72" font-weight="800" fill="#000000">FS8</text></svg>`;

/**
 * The line between "typeset" and "tofu".
 *
 * Measured, not guessed: the probe covers ~17% of its canvas when a font is
 * available and ~0.5% when fontconfig has nothing to offer and librsvg falls
 * back to replacement boxes. Anything below this is not text.
 */
export const MIN_PROBE_COVERAGE = 0.05;

/** Fraction of the probe covered in ink. Exported for the test suite. */
export async function probeInkCoverage(): Promise<number> {
  ensureFontsConfigured();
  const { data } = await sharp(Buffer.from(PROBE_SVG, 'utf8'), { density: 144 })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (const byte of data) if (byte < 128) dark++;
  return data.length === 0 ? 0 : dark / data.length;
}

let probe: Promise<void> | null = null;

/**
 * Throws unless this process can genuinely draw text.
 *
 * Run once per process and cached, because the answer cannot change while the
 * process lives — and because it must be cheap enough to sit in front of every
 * rasterisation without anybody being tempted to skip it.
 */
export function assertTextRenderable(): Promise<void> {
  probe ??= (async () => {
    const coverage = await probeInkCoverage();
    if (coverage >= MIN_PROBE_COVERAGE) {
      log.info('text rendering verified', { coverage: Number(coverage.toFixed(4)) });
      return;
    }
    const dir = fontDirectory();
    throw new FullSendError(
      'creative_fonts_unavailable',
      'This deployment cannot draw text into creative, so every generated image would be blank',
      {
        retryable: false,
        remedy: dir
          ? 'The bundled fonts were found but fontconfig will not use them. Check that the ' +
            'temporary directory is writable, or set FONTCONFIG_FILE to a configuration that ' +
            `includes ${dir}.`
          : 'The bundled fonts did not reach this deployment. Set FULLSEND_FONT_DIR to the ' +
            'directory holding Inter-Regular.ttf, or redeploy so assets/fonts ships with the ' +
            'application.',
        meta: { coverage, fontDirectory: dir },
      },
    );
  })();
  return probe;
}

/** Test seam: forget the cached probe and configuration. */
export function resetFontState(): void {
  probe = null;
  setup = null;
}

/** What the Control Room reports about this deployment's ability to draw. */
export async function fontHealth(): Promise<{
  ok: boolean;
  coverage: number;
  directory: string | null;
  detail: string | null;
}> {
  const directory = fontDirectory();
  try {
    const coverage = await probeInkCoverage();
    return {
      ok: coverage >= MIN_PROBE_COVERAGE,
      coverage,
      directory,
      detail:
        coverage >= MIN_PROBE_COVERAGE
          ? null
          : 'Text renders as empty boxes here. Generated creative would publish blank.',
    };
  } catch (e) {
    return { ok: false, coverage: 0, directory, detail: String(e) };
  }
}
