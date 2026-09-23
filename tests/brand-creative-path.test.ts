/**
 * Brand identity must reach Instagram creatives — colours, logo, screenshots —
 * whether the project was grounded in GitHub or a website. Neutral fallbacks
 * are honest when signals are thin; inventing an aesthetic is not.
 */
import { describe, expect, it } from 'vitest';
import { discoverBrandIdentityFromHtml } from '@/lib/brand/discover';
import { identityFrom, identityPatch, paletteFor, NEUTRAL_PALETTE } from '@/lib/brand/identity';
import { hookCard, resolveLogoEmbed, slideCard } from '@/lib/creative/render';
import type { BrandProfile, ProductAnalysis } from '@/lib/types';

const SAMPLE_HTML = `<!doctype html>
<html>
<head>
  <title>PlayPal — Golf with friends</title>
  <meta name="theme-color" content="#0E2B20" />
  <meta property="og:image" content="https://playpal.example/og.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <style>
    :root {
      --color-primary: #0E2B20;
      --color-background: #F7F4EF;
      --color-text: #1A1A1A;
      --font-heading: "Fraunces", Georgia, serif;
      --font-body: "Inter", system-ui, sans-serif;
    }
    body { background: #F7F4EF; color: #1A1A1A; font-family: Inter, system-ui, sans-serif; }
    h1 { font-family: Fraunces, Georgia, serif; color: #0E2B20; }
  </style>
</head>
<body><h1>PlayPal</h1></body>
</html>`;

describe('website HTML brand discovery', () => {
  it('reads theme-color, type, logo, and name from a public page', () => {
    const identity = discoverBrandIdentityFromHtml([
      { url: 'https://playpal.example/', html: SAMPLE_HTML },
    ]);

    expect(identity.primary_color?.value.toLowerCase()).toBe('#0e2b20');
    expect(identity.brand_name?.value).toBe('PlayPal');
    expect(identity.logo_url?.value).toContain('apple-touch-icon.png');
    expect(identity.heading_font?.value || identity.body_font?.value).toBeTruthy();
    expect(identity.evidence.unresolved).not.toContain('primary_color');
  });

  it('leaves gaps unnamed as invented when the page states nothing', () => {
    const identity = discoverBrandIdentityFromHtml([
      { url: 'https://plain.example/', html: '<html><head><title>x</title></head><body>hi</body></html>' },
    ]);
    expect(identity.primary_color).toBeUndefined();
    expect(identity.evidence.unresolved).toContain('primary_color');
  });
});

describe('brand identity → render palette → card', () => {
  it('applies website-discovered colours onto the SVG card a founder would see', () => {
    const identity = discoverBrandIdentityFromHtml([
      { url: 'https://playpal.example/', html: SAMPLE_HTML },
    ]);
    const { patch } = identityPatch(identity, null);
    const brand = {
      primary_color: String(patch.primary_color ?? ''),
      secondary_color: '',
      accent_color: String(patch.accent_color ?? ''),
      background_color: String(patch.background_color ?? ''),
      text_color: String(patch.text_color ?? ''),
      heading_font: String(patch.heading_font ?? ''),
      body_font: String(patch.body_font ?? ''),
      logo_url: (patch.logo_url as string | null | undefined) ?? null,
    } satisfies Pick<
      BrandProfile,
      | 'primary_color'
      | 'secondary_color'
      | 'accent_color'
      | 'background_color'
      | 'text_color'
      | 'heading_font'
      | 'body_font'
      | 'logo_url'
    >;

    const palette = paletteFor(brand);
    expect(palette.accent.toLowerCase()).toBe('#0e2b20');
    expect(palette.accent.toLowerCase()).not.toBe(NEUTRAL_PALETTE.accent.toLowerCase());

    // Remote logos are not inlined by hookCard itself — that path used to leave
    // a broken <image href>. Colour identity still lands without the mark.
    const svg = hookCard({
      hook: 'Golf nights, sorted',
      cta: 'Try PlayPal',
      palette,
      size: { w: 1080, h: 1350 },
      footer: 'PlayPal',
      badge: 'INSTAGRAM',
      logoUrl: brand.logo_url,
    });
    expect(svg).toContain('#0e2b20');
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('#ff5a1f');
  });

  it('puts an inlined logo on a carousel cover when the mark resolved', () => {
    const palette = paletteFor({
      primary_color: '#123456',
      secondary_color: '',
      accent_color: '',
      background_color: '#ffffff',
      text_color: '#111111',
      heading_font: 'Fraunces',
      body_font: 'Inter',
      logo_url: 'https://cdn.example/logo.png',
    });
    const embed = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const cover = slideCard({
      headline: 'Three taps',
      body: 'That is the whole flow.',
      index: 0,
      total: 3,
      palette,
      size: { w: 1080, h: 1350 },
      footer: 'Acme',
      logoUrl: embed,
    });
    expect(cover).toContain('data:image/png;base64,');
    expect(cover).toContain('<image href="data:image/png');
    expect(cover).not.toContain('https://cdn.example/logo.png');
  });
});

describe('website analysis identity slot', () => {
  it('identityFrom reads brand_identity written the same way as GitHub', () => {
    const identity = discoverBrandIdentityFromHtml([
      { url: 'https://playpal.example/', html: SAMPLE_HTML },
    ]);
    const analysis = {
      raw_signals: {
        source: 'website',
        brand_identity: identity,
      },
    } as unknown as ProductAnalysis;
    const back = identityFrom(analysis);
    expect(back?.primary_color?.value.toLowerCase()).toBe('#0e2b20');
  });
});

describe('resolveLogoEmbed', () => {
  const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  it('inlines a remote logo URL as a data URI', async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
    try {
      const embed = await resolveLogoEmbed('https://cdn.example/logo.png');
      expect(embed).toMatch(/^data:image\/png;base64,/);
      expect(embed!.length).toBeGreaterThan('data:image/png;base64,'.length);
    } finally {
      globalThis.fetch = prev;
    }
  });

  it('omits the mark cleanly when the remote fetch fails', async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    try {
      await expect(resolveLogoEmbed('https://cdn.example/missing.png')).resolves.toBeNull();
    } finally {
      globalThis.fetch = prev;
    }
  });

  it('passes through an already-inlined data URI', async () => {
    const data = 'data:image/png;base64,abc';
    await expect(resolveLogoEmbed(data)).resolves.toBe(data);
  });

  it('refuses non-http schemes rather than embedding them', async () => {
    await expect(resolveLogoEmbed('file:///etc/passwd')).resolves.toBeNull();
    await expect(resolveLogoEmbed('javascript:alert(1)')).resolves.toBeNull();
  });
});
