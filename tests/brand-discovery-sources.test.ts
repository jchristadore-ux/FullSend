/**
 * Where a product's brand is actually written down.
 *
 * Discovery used to read `.css`/`.scss`/`.less` and a Tailwind config, and
 * nothing else. PlayPal — a self-contained PWA — states its brand four times
 * over, in a web manifest, a Capacitor config, a `<meta name="theme-color">`
 * and one inline `<style>` block, and discovery reported "not found in the
 * repository" for every single field. Every post then rendered in the neutral
 * palette, which is why the posts did not look like the product.
 *
 * The fixture below is PlayPal's real structure, with its real values.
 */
import { describe, expect, it } from 'vitest';
import { fakeGitHubClient } from './helpers';
import type { TreeEntry } from '@/lib/github/client';
import {
  discoverBrandIdentity,
  extractColorTokens,
  extractFontFaces,
  inlineStyles,
  manifestBrandName,
  manifestColors,
  metaThemeColor,
  normaliseColor,
  rootColors,
  titleBrand,
} from '@/lib/brand/discover';

const MANIFEST = JSON.stringify({
  name: 'PlayPal — Golf Companion',
  short_name: 'PlayPal',
  background_color: '#0E2B20',
  theme_color: '#0E2B20',
});

const CAPACITOR = JSON.stringify({
  appId: 'com.playpal.golf',
  appName: 'PlayPal',
  backgroundColor: '#0E2B20',
});

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta name="theme-color" content="#0E2B20"/>
<title>PlayPal — Golf Companion</title>
<link href="vendor/fonts.css" rel="stylesheet"/>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; background: #F6F4EE; color: #0E2B20; font-family: 'Plus Jakarta Sans', 'Inter', system-ui, sans-serif; }
  input::placeholder { color: #8A9E8A; }
  :focus-visible { outline: 2px solid #C8A15A; outline-offset: 2px; }
  .pp-join-code { color: #C8A15A; border: 1px solid #C8A15A; }
</style>
</head>
<body><div id="root"></div></body>
</html>`;

/** The tree GitHub would report for a fixture's files. */
function treeOf(files: { path: string; content?: string; size?: number }[]): TreeEntry[] {
  return files.map((f) => ({
    path: f.path,
    type: 'blob' as const,
    size: f.size ?? f.content?.length ?? 1,
  }));
}

const PLAYPAL_FILES = [
  { path: 'package.json', content: '{"name":"playpal"}' },
  { path: 'manifest.webmanifest', content: MANIFEST },
  { path: 'capacitor.config.json', content: CAPACITOR },
  { path: 'index.html', content: INDEX_HTML },
  { path: 'vendor/fonts.css', content: "@font-face { font-family: 'Plus Jakarta Sans'; }" },
  { path: 'playpal-logo.png', content: 'PNG', size: 40_000 },
];

describe('a PWA that states its brand outside any stylesheet', () => {
  async function discover() {
    return discoverBrandIdentity(
      { owner: 'jchristadore-ux', name: 'playpal' },
      fakeGitHubClient({ owner: 'jchristadore-ux', name: 'playpal', files: PLAYPAL_FILES }),
      'main',
      treeOf(PLAYPAL_FILES),
    );
  }

  it('reads the brand colour from the manifest that exists to state it', async () => {
    const id = await discover();
    expect(id.primary_color?.value).toBe('#0e2b20');
  });

  it('reads the page ground and ink from the root rule of an inline style block', async () => {
    const id = await discover();
    // The manifest also says #0E2B20 for background — but that is the splash
    // colour, and the product's actual ground is bone white.
    expect(id.background_color?.value).toBe('#f6f4ee');
    expect(id.background_color?.source).toBe('index.html');
    expect(id.text_color?.value).toBe('#0e2b20');
  });

  it('reads the typeface out of the inline style block', async () => {
    const id = await discover();
    expect(id.body_font?.value).toBe('Plus Jakarta Sans, Inter, system-ui, sans-serif');
    expect(id.heading_font?.value).toBe('Plus Jakarta Sans, Inter, system-ui, sans-serif');
  });

  it('takes the accent from the colour the product decorates with', async () => {
    const id = await discover();
    expect(id.accent_color?.value).toBe('#c8a15a');
  });

  it('names the brand, which no code ever used to assign at all', async () => {
    const id = await discover();
    expect(id.brand_name?.value).toBe('PlayPal');
    expect(id.brand_name?.source).toBe('manifest.webmanifest');
  });

  it('still finds the mark', async () => {
    const id = await discover();
    expect(id.logo_url?.value).toContain('playpal-logo.png');
  });

  it('leaves only what the repository genuinely never says', async () => {
    const id = await discover();
    expect(id.evidence.unresolved).toEqual(['secondary_color']);
  });
});

describe('colour notation', () => {
  it('does not truncate a six-digit hex to a four-digit one', () => {
    // The bug this guards: ordered alternation matched `#F6F4` out of
    // `#F6F4EE`, normalised it as shorthand, and returned magenta.
    expect(normaliseColor('#F6F4EE')).toBe('#f6f4ee');
    expect(extractColorTokens('--bg: #F6F4EE;')).toEqual([
      { name: 'bg', value: '#f6f4ee' },
    ]);
  });

  it('expands shorthand and drops the alpha channel', () => {
    expect(normaliseColor('#f6f')).toBe('#ff66ff');
    expect(normaliseColor('#0E2B20FF')).toBe('#0e2b20');
    expect(normaliseColor('#abcd')).toBe('#aabbcc');
  });

  it('reads rgb() and hsl(), in comma and space syntax', () => {
    expect(normaliseColor('rgb(14, 43, 32)')).toBe('#0e2b20');
    expect(normaliseColor('rgb(14 43 32)')).toBe('#0e2b20');
    expect(normaliseColor('rgba(14,43,32,0.5)')).toBe('#0e2b20');
    expect(normaliseColor('hsl(0 0% 100%)')).toBe('#ffffff');
    expect(normaliseColor('hsl(0 0% 0%)')).toBe('#000000');
    expect(normaliseColor('hsl(0 100% 50%)')).toBe('#ff0000');
    expect(normaliseColor('hsl(120 100% 50%)')).toBe('#00ff00');
    expect(normaliseColor('hsl(240 100% 50%)')).toBe('#0000ff');
    expect(normaliseColor('hsl(158 51% 11%)')).toBe('#0e2a20');
  });

  it('reads a bare hsl triple, which is how shadcn writes a theme', () => {
    expect(extractColorTokens('--primary: 158 51% 11%;')).toEqual([
      { name: 'primary', value: '#0e2a20' },
    ]);
    // The real shadcn default, which produced no token at all before.
    expect(extractColorTokens('--primary: 221.2 83.2% 53.3%;')[0].name).toBe('primary');
    expect(extractColorTokens('--primary: 221.2 83.2% 53.3%;')[0].value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('refuses what is not a colour', () => {
    expect(normaliseColor('var(--brand)')).toBeNull();
    expect(normaliseColor('#12')).toBeNull();
    expect(normaliseColor('transparent')).toBeNull();
    expect(normaliseColor('rgb(14 43)')).toBeNull();
  });
});

describe('the parsers, individually', () => {
  it('pulls every style block out of a document', () => {
    expect(inlineStyles('<style>a{}</style>x<style>b{}</style>')).toEqual(['a{}', 'b{}']);
    expect(inlineStyles('<p>no styles</p>')).toEqual([]);
  });

  it('finds theme-color in either attribute order', () => {
    expect(metaThemeColor('<meta name="theme-color" content="#0E2B20">')).toBe('#0e2b20');
    expect(metaThemeColor('<meta content="#0E2B20" name="theme-color">')).toBe('#0e2b20');
    expect(metaThemeColor('<meta name="description" content="#0E2B20">')).toBeNull();
  });

  it('takes the brand off a title and leaves the tagline', () => {
    expect(titleBrand('<title>PlayPal — Golf Companion</title>')).toBe('PlayPal');
    expect(titleBrand('<title>Acme | Invoicing</title>')).toBe('Acme');
    expect(titleBrand('<title>Taskflow</title>')).toBe('Taskflow');
  });

  it('reads an Expo config nested under its expo key', () => {
    const body = JSON.stringify({
      expo: { name: 'Taskflow', primaryColor: '#1A73E8', splash: { backgroundColor: '#FFFFFF' } },
    });
    expect(manifestBrandName(body)).toBe('Taskflow');
    expect(manifestColors(body)).toEqual([
      { name: 'primary_color', value: '#1a73e8' },
      { name: 'background_color', value: '#ffffff' },
    ]);
  });

  it('falls back to a pattern when an app config is a module it cannot run', () => {
    expect(manifestBrandName("export default { appName: 'Taskflow' }")).toBe('Taskflow');
    expect(manifestColors("export default { backgroundColor: '#0E2B20' }")).toEqual([
      { name: 'background_color', value: '#0e2b20' },
    ]);
  });

  it('will not take an npm scope for a brand name', () => {
    expect(manifestBrandName('{"name":"@acme/web"}')).toBeNull();
  });

  it('reads the root rule whatever selector it is written with', () => {
    expect(rootColors('html, body { background: #fff; color: #111; }')).toEqual([
      { slot: 'background_color', value: '#ffffff' },
      { slot: 'text_color', value: '#111111' },
    ]);
    expect(rootColors(':root{background-color:rgb(14 43 32)}')).toEqual([
      { slot: 'background_color', value: '#0e2b20' },
    ]);
    // A component rule is not the document's ground.
    expect(rootColors('.card { background: #fff; }')).toEqual([]);
  });

  it('reads a bundled family as the product typeface', () => {
    expect(extractFontFaces("@font-face { font-family: 'Plus Jakarta Sans'; src: url(x); }")).toEqual([
      'Plus Jakarta Sans',
    ]);
  });
});

describe('a theme module, which was ranked highest and never opened', () => {
  it('reads a palette out of theme.ts', async () => {
    const files = [
      {
        path: 'src/theme.ts',
        content: `export const theme = {
          primary: '#1A73E8',
          secondary: '#34A853',
          accent: '#FBBC04',
          background: '#FFFFFF',
          foreground: '#202124',
        };`,
      },
    ];
    const id = await discoverBrandIdentity(
      { owner: 'acme', name: 'taskflow' },
      fakeGitHubClient({ owner: 'acme', name: 'taskflow', files }),
      'main',
      treeOf(files),
    );
    expect(id.evidence.style_files).toContain('src/theme.ts');
    expect(id.primary_color?.value).toBe('#1a73e8');
    expect(id.secondary_color?.value).toBe('#34a853');
    expect(id.accent_color?.value).toBe('#fbbc04');
    expect(id.background_color?.value).toBe('#ffffff');
    expect(id.text_color?.value).toBe('#202124');
  });
});

describe('a silent repository is still unknown, not guessed', () => {
  it('finds nothing in a repository that states nothing', async () => {
    const files = [
      { path: 'package.json', content: '{"name":"quiet"}' },
      { path: 'src/index.ts', content: 'export const x = 1;' },
    ];
    const id = await discoverBrandIdentity(
      { owner: 'acme', name: 'quiet' },
      fakeGitHubClient({ owner: 'acme', name: 'quiet', files }),
      'main',
      treeOf(files),
    );
    expect(id.primary_color).toBeUndefined();
    expect(id.brand_name).toBeUndefined();
    expect(id.accent_color).toBeUndefined();
    expect(id.evidence.unresolved).toContain('primary_color');
    expect(id.evidence.unresolved).toContain('brand_name');
  });

  it('does not invent an accent from a grey used twice', async () => {
    const files = [
      {
        path: 'src/styles.css',
        content: '.a{border:1px solid #E5E5E5}.b{border:1px solid #E5E5E5}',
      },
    ];
    const id = await discoverBrandIdentity(
      { owner: 'acme', name: 'greys' },
      fakeGitHubClient({ owner: 'acme', name: 'greys', files }),
      'main',
      treeOf(files),
    );
    expect(id.accent_color).toBeUndefined();
  });
});
