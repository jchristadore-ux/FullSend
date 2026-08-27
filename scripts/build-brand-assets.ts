/**
 * Renders every FullSend brand asset into public/brand.
 *
 * Run with `npm run brand`. Checked-in output is regenerated, not hand-edited.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  fullsendLockupSvg,
  fullsendIconSvg,
  fullsendFaviconSvg,
  fullsendAppIconSvg,
  fullsendSocialAvatarSvg,
} from '../src/lib/brand/logo';
import { FULLSEND_COLORS } from '../src/lib/brand/fullsend-brand';

const OUT = path.join(process.cwd(), 'public', 'brand');
fs.mkdirSync(OUT, { recursive: true });

const assets: Record<string, string> = {
  // 1. Full horizontal lockup
  'fullsend-lockup-dark.svg': fullsendLockupSvg({ tone: 'dark' }),
  'fullsend-lockup-light.svg': fullsendLockupSvg({ tone: 'light' }),
  'fullsend-lockup-onblack.svg': fullsendLockupSvg({ tone: 'dark', background: FULLSEND_COLORS.void }),
  // 8. Monochrome
  'fullsend-lockup-mono-white.svg': fullsendLockupSvg({ tone: 'mono-white' }),
  'fullsend-lockup-mono-black.svg': fullsendLockupSvg({ tone: 'mono-black' }),

  // 2. Icon only
  'fullsend-icon-dark.svg': fullsendIconSvg({ tone: 'dark' }),
  'fullsend-icon-light.svg': fullsendIconSvg({ tone: 'light' }),
  'fullsend-icon-mono-white.svg': fullsendIconSvg({ tone: 'mono-white' }),
  'fullsend-icon-mono-black.svg': fullsendIconSvg({ tone: 'mono-black' }),
  'fullsend-icon-compact.svg': fullsendIconSvg({ tone: 'dark', compact: true }),

  // 3. Favicon  4. App icon  5. Social profile image
  'favicon.svg': fullsendFaviconSvg(),
  'fullsend-app-icon.svg': fullsendAppIconSvg(),
  'fullsend-social-avatar.svg': fullsendSocialAvatarSvg(),
};

for (const [name, svg] of Object.entries(assets)) {
  fs.writeFileSync(path.join(OUT, name), svg + '\n', 'utf8');
}

// Favicon also lives at the web root so browsers find it with no markup.
fs.writeFileSync(path.join(process.cwd(), 'public', 'favicon.svg'), fullsendFaviconSvg() + '\n');

/*
 * Home-screen icons, as PNG.
 *
 * "Add to Home Screen" cannot use the SVG. iOS accepts only PNG or JPEG for a
 * touch icon and silently ignores anything else — it then screenshots the page
 * instead, which is what a missing icon actually looks like. Android reads the
 * manifest, which needs real pixel sizes too.
 *
 * Rendered from the same source as every other asset, so the icon cannot drift
 * from the brand: change the mark, run `npm run brand`, and these follow.
 */
const RASTER: { file: string; size: number; maskable?: boolean }[] = [
  // iOS home screen, 180 being what current iPhones ask for. Full-bleed: iOS
  // rounds a touch icon itself, so shipping rounded corners rounds them twice
  // and leaves dark notches down the sides.
  { file: 'fullsend-app-icon-180.png', size: 180, maskable: true },
  // Android / Chrome install prompts, via the manifest. Shown as-is in some
  // surfaces, so these keep the corners.
  { file: 'fullsend-app-icon-192.png', size: 192 },
  { file: 'fullsend-app-icon-512.png', size: 512 },
  // Full-bleed again, for launchers that crop to their own shape.
  { file: 'fullsend-app-icon-maskable-512.png', size: 512, maskable: true },
];

async function writeRasterIcons(): Promise<void> {
  await Promise.all(
    RASTER.map(async ({ file, size, maskable }) => {
      const svg = fullsendAppIconSvg(size, { maskable });
      await sharp(Buffer.from(svg, 'utf8'), { density: 384 })
        .resize(size, size, { fit: 'contain' })
        .png()
        .toFile(path.join(OUT, file));
    }),
  );
}

// A contact sheet so the brand can be eyeballed on both grounds at every size.
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 760" width="1200" height="760">
<rect width="1200" height="380" fill="${FULLSEND_COLORS.void}"/>
<rect y="380" width="1200" height="380" fill="#FFFFFF"/>
<g transform="translate(60 70) scale(0.95)">${stripSvgWrapper(fullsendLockupSvg({ tone: 'dark' }))}</g>
<g transform="translate(60 450) scale(0.95)">${stripSvgWrapper(fullsendLockupSvg({ tone: 'light' }))}</g>
<g transform="translate(60 210) scale(0.9)">${stripSvgWrapper(fullsendIconSvg({ tone: 'dark' }))}</g>
<g transform="translate(200 228) scale(0.55)">${stripSvgWrapper(fullsendIconSvg({ tone: 'dark', compact: true }))}</g>
<g transform="translate(290 244) scale(0.3)">${stripSvgWrapper(fullsendIconSvg({ tone: 'dark', compact: true }))}</g>
<g transform="translate(340 250) scale(0.16)">${stripSvgWrapper(fullsendIconSvg({ tone: 'dark', compact: true }))}</g>
<g transform="translate(60 590) scale(0.9)">${stripSvgWrapper(fullsendIconSvg({ tone: 'light' }))}</g>
<g transform="translate(200 608) scale(0.55)">${stripSvgWrapper(fullsendIconSvg({ tone: 'light', compact: true }))}</g>
<g transform="translate(290 624) scale(0.3)">${stripSvgWrapper(fullsendIconSvg({ tone: 'light', compact: true }))}</g>
<g transform="translate(340 630) scale(0.16)">${stripSvgWrapper(fullsendIconSvg({ tone: 'light', compact: true }))}</g>
</svg>`;
fs.writeFileSync(path.join(OUT, 'fullsend-contact-sheet.svg'), sheet + '\n');

function stripSvgWrapper(svg: string): string {
  return svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
}

// eslint-disable-next-line no-console
console.log(
  `FullSend brand assets written to public/brand (${Object.keys(assets).length + 2} files).`,
);

writeRasterIcons().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Could not render the home-screen icons:', e);
  process.exitCode = 1;
});
