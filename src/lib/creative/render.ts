/**
 * Creative generation.
 *
 * Produces real, on-brand visual assets locally as SVG — correctly sized per
 * platform and format, typeset from the actual hook and slide copy, coloured
 * from the project's brand profile. No placeholders and no "image coming soon".
 *
 * When a repo screenshot exists for a referenced screen, it is used as the demo
 * visual instead of a generated card. When an image-generation provider is
 * configured it can supplant this; until then this is what publishes.
 */
import 'server-only';
import { type TenantScope } from '../db';
import { db } from '../db/repo';
import { newId, nowIso } from '../ids';
import type {
  BrandProfile,
  ContentItem,
  CreativeAsset,
  ProductAnalysis,
  Project,
} from '../types';

/** Platform-correct canvas sizes. */
export const CANVAS: Record<string, { w: number; h: number }> = {
  reel: { w: 1080, h: 1920 },
  short_video: { w: 1080, h: 1920 },
  story: { w: 1080, h: 1920 },
  carousel: { w: 1080, h: 1350 },
  static: { w: 1080, h: 1350 },
  text: { w: 1080, h: 1080 },
};

export interface RenderInput {
  project: Project;
  item: ContentItem;
  brand: BrandProfile;
  analysis: ProductAnalysis;
}

export async function renderCreative(
  scope: TenantScope,
  input: RenderInput,
): Promise<CreativeAsset[]> {
  const { project, item, brand, analysis } = input;
  const size = CANVAS[item.format] ?? CANVAS.static;
  const assets: CreativeAsset[] = [];

  const palette = {
    accent: brand.primary_color || '#FF5A1F',
    fg: brand.secondary_color || '#FFFFFF',
    bg: brand.background_color || '#08090A',
  };

  if (item.format === 'carousel' && item.slides?.length) {
    for (let i = 0; i < item.slides.length; i++) {
      const slide = item.slides[i];
      assets.push(
        await save(scope, project.id, item.id, {
          kind: 'carousel_slide',
          source: 'svg_render',
          width: size.w,
          height: size.h,
          svg: slideCard({
            headline: slide.headline,
            body: slide.body,
            index: i,
            total: item.slides.length,
            palette,
            size,
            footer: project.name,
          }),
          alt_text: `${slide.headline} — slide ${i + 1} of ${item.slides.length}`,
        }),
      );
    }
    return assets;
  }

  /*
   * The branded hook card leads. It is rendered locally, so it always exists
   * and is always correctly sized — a repo screenshot might 404 or be the wrong
   * aspect ratio, and a post whose first image fails is a failed post.
   */
  assets.push(
    await save(scope, project.id, item.id, {
      kind: isVideo(item.format) ? 'thumbnail' : 'image',
      source: 'svg_render',
      width: size.w,
      height: size.h,
      svg: hookCard({
        hook: item.hook,
        cta: item.cta,
        palette,
        size,
        footer: project.name,
        badge: labelFor(item),
      }),
      alt_text: item.hook,
    }),
  );

  // A real product screenshot follows it when the repo has a relevant one.
  const screen = findScreenForItem(item, analysis);
  if (screen?.image_url) {
    assets.push(
      await save(scope, project.id, item.id, {
        kind: 'image',
        source: 'repo_screenshot',
        width: size.w,
        height: size.h,
        url: screen.image_url,
        svg: null,
        mime_type: guessMime(screen.image_url),
        alt_text: `${screen.name} in ${project.name}`,
      }),
    );
  }

  return assets;
}

function isVideo(format: string): boolean {
  return format === 'reel' || format === 'short_video' || format === 'story';
}

function labelFor(item: ContentItem): string {
  if (item.format === 'reel') return 'REEL';
  if (item.format === 'short_video') return 'TIKTOK';
  if (item.format === 'story') return 'STORY';
  return item.platform.toUpperCase();
}

function guessMime(url: string): string {
  if (/\.png(\?|$)/i.test(url)) return 'image/png';
  if (/\.(jpe?g)(\?|$)/i.test(url)) return 'image/jpeg';
  if (/\.gif(\?|$)/i.test(url)) return 'image/gif';
  if (/\.webp(\?|$)/i.test(url)) return 'image/webp';
  if (/\.svg(\?|$)/i.test(url)) return 'image/svg+xml';
  return 'image/png';
}

function findScreenForItem(item: ContentItem, analysis: ProductAnalysis) {
  const ref = item.video_plan?.scenes.find((s) => s.screen_reference)?.screen_reference;
  if (ref) {
    const hit = analysis.screens.find((s) => s.name === ref);
    if (hit) return hit;
  }
  const text = `${item.hook} ${item.caption}`.toLowerCase();
  return (
    analysis.screens.find((s) => s.image_url && text.includes(s.name.toLowerCase())) ??
    (isVideo(item.format) ? analysis.screens.find((s) => s.image_url) : null) ??
    null
  );
}

async function save(
  scope: TenantScope,
  projectId: string,
  itemId: string,
  a: {
    kind: CreativeAsset['kind'];
    source: CreativeAsset['source'];
    width: number;
    height: number;
    svg: string | null;
    url?: string | null;
    mime_type?: string;
    alt_text: string;
  },
): Promise<CreativeAsset> {
  return db().insert(scope, 'creative_assets', {
    id: newId(),
    project_id: projectId,
    content_item_id: itemId,
    kind: a.kind,
    source: a.source,
    mime_type: a.mime_type ?? 'image/svg+xml',
    width: a.width,
    height: a.height,
    url: a.url ?? null,
    storage_path: null,
    svg: a.svg,
    alt_text: a.alt_text,
    created_at: nowIso(),
  });
}

/* ── SVG typesetting ────────────────────────────────────────────────────── */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Greedy line breaking against an average glyph width. Good enough for display
 * type at these sizes, and avoids needing a font metrics library server-side.
 */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = next;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
  }
  return lines;
}

interface Palette {
  accent: string;
  fg: string;
  bg: string;
}

function baseDefs(palette: Palette, id: string): string {
  return `<defs>
  <radialGradient id="glow-${id}" cx="0.5" cy="0.12" r="0.85">
    <stop offset="0%" stop-color="${palette.accent}" stop-opacity="0.26"/>
    <stop offset="100%" stop-color="${palette.accent}" stop-opacity="0"/>
  </radialGradient>
  <pattern id="grid-${id}" width="60" height="60" patternUnits="userSpaceOnUse">
    <path d="M60 0 L0 0 0 60" fill="none" stroke="${palette.fg}" stroke-opacity="0.045" stroke-width="1"/>
  </pattern>
</defs>`;
}

export function hookCard(opts: {
  hook: string;
  cta: string;
  palette: Palette;
  size: { w: number; h: number };
  footer: string;
  badge: string;
}): string {
  const { hook, cta, palette, size, footer, badge } = opts;
  const id = 'h';
  const pad = Math.round(size.w * 0.09);
  // Larger type for short hooks, smaller for long ones.
  const fontSize = hook.length < 40 ? size.w * 0.115 : hook.length < 80 ? size.w * 0.09 : size.w * 0.072;
  const maxChars = Math.floor((size.w - pad * 2) / (fontSize * 0.52));
  const lines = wrapText(hook, maxChars, 5);
  const lineHeight = fontSize * 1.08;
  const blockHeight = lines.length * lineHeight;
  const startY = size.h / 2 - blockHeight / 2 + fontSize * 0.78;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size.w} ${size.h}" width="${size.w}" height="${size.h}">
${baseDefs(palette, id)}
<rect width="${size.w}" height="${size.h}" fill="${palette.bg}"/>
<rect width="${size.w}" height="${size.h}" fill="url(#grid-${id})"/>
<rect width="${size.w}" height="${size.h}" fill="url(#glow-${id})"/>
<rect x="0" y="0" width="${Math.round(size.w * 0.018)}" height="${size.h}" fill="${palette.accent}"/>
<g font-family="Archivo, Helvetica Neue, Arial, sans-serif">
  <text x="${pad}" y="${pad + 30}" font-size="${Math.round(size.w * 0.028)}" font-weight="700"
        letter-spacing="4" fill="${palette.accent}">${esc(badge)}</text>
${lines
  .map(
    (l, i) =>
      `  <text x="${pad}" y="${Math.round(startY + i * lineHeight)}" font-size="${Math.round(fontSize)}" font-weight="800" letter-spacing="-2" fill="${palette.fg}">${esc(l)}</text>`,
  )
  .join('\n')}
  <rect x="${pad}" y="${size.h - pad - 92}" width="${Math.round(size.w * 0.26)}" height="6" fill="${palette.accent}"/>
  <text x="${pad}" y="${size.h - pad - 34}" font-size="${Math.round(size.w * 0.036)}" font-weight="700"
        fill="${palette.fg}" fill-opacity="0.92">${esc(cta || footer)}</text>
  <text x="${size.w - pad}" y="${size.h - pad - 34}" text-anchor="end" font-size="${Math.round(size.w * 0.026)}"
        font-weight="600" letter-spacing="2" fill="${palette.fg}" fill-opacity="0.45">${esc(footer.toUpperCase())}</text>
</g>
</svg>`;
}

export function slideCard(opts: {
  headline: string;
  body: string;
  index: number;
  total: number;
  palette: Palette;
  size: { w: number; h: number };
  footer: string;
}): string {
  const { headline, body, index, total, palette, size, footer } = opts;
  const id = `s${index}`;
  const pad = Math.round(size.w * 0.085);
  const isCover = index === 0;
  const headSize = isCover ? size.w * 0.105 : size.w * 0.078;
  const headLines = wrapText(headline, Math.floor((size.w - pad * 2) / (headSize * 0.52)), 4);
  const bodySize = size.w * 0.042;
  const bodyLines = wrapText(body, Math.floor((size.w - pad * 2) / (bodySize * 0.54)), 5);

  const headStart = pad + headSize * 1.5;
  const bodyStart = headStart + headLines.length * headSize * 1.1 + bodySize * 1.8;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size.w} ${size.h}" width="${size.w}" height="${size.h}">
${baseDefs(palette, id)}
<rect width="${size.w}" height="${size.h}" fill="${palette.bg}"/>
<rect width="${size.w}" height="${size.h}" fill="url(#grid-${id})"/>
${isCover ? `<rect width="${size.w}" height="${size.h}" fill="url(#glow-${id})"/>` : ''}
<g font-family="Archivo, Helvetica Neue, Arial, sans-serif">
  <text x="${pad}" y="${pad + 24}" font-size="${Math.round(size.w * 0.026)}" font-weight="700"
        letter-spacing="4" fill="${palette.accent}">${index + 1} / ${total}</text>
${headLines
  .map(
    (l, i) =>
      `  <text x="${pad}" y="${Math.round(headStart + i * headSize * 1.1)}" font-size="${Math.round(headSize)}" font-weight="800" letter-spacing="-2" fill="${palette.fg}">${esc(l)}</text>`,
  )
  .join('\n')}
${bodyLines
  .map(
    (l, i) =>
      `  <text x="${pad}" y="${Math.round(bodyStart + i * bodySize * 1.45)}" font-size="${Math.round(bodySize)}" font-weight="500" fill="${palette.fg}" fill-opacity="0.74">${esc(l)}</text>`,
  )
  .join('\n')}
  <rect x="${pad}" y="${size.h - pad - 52}" width="${Math.round(size.w * 0.14)}" height="5" fill="${palette.accent}"/>
  <text x="${size.w - pad}" y="${size.h - pad - 22}" text-anchor="end" font-size="${Math.round(size.w * 0.024)}"
        font-weight="600" letter-spacing="2" fill="${palette.fg}" fill-opacity="0.45">${esc(footer.toUpperCase())}</text>
${index === total - 1 ? `  <text x="${pad}" y="${size.h - pad - 18}" font-size="${Math.round(size.w * 0.03)}" font-weight="700" fill="${palette.accent}">→</text>` : ''}
</g>
</svg>`;
}

/** Data URI form, for previewing an asset without a storage round-trip. */
export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
