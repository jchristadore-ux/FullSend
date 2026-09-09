/**
 * Website ingestion.
 *
 * Turns a public product site into a compact bundle of signals: title, meta
 * description, headings, body copy, and a few same-origin pages when they are
 * linked. The bundle feeds the same product-analysis schema the GitHub path
 * uses — claims must still cite evidence from what was fetched.
 */
import 'server-only';
import { logger } from '../logger';
import type { AppScreen } from '../types';
import { fetchPublicHtml, type FetchedPage } from './fetch';
import { assertSafePublicUrl } from './ssrf';
import { canonicalWebsiteUrl, parseWebsiteUrl } from './url';

const log = logger('website.ingest');

const EXTRA_PATHS = ['/pricing', '/about', '/features', '/product', '/solutions'];
const MAX_EXTRA_PAGES = 3;
const MAX_TEXT_CHARS = 6_000;
const MAX_HEADINGS = 40;

export interface WebsitePageSignals {
  url: string;
  title: string | null;
  meta_description: string | null;
  headings: string[];
  text_excerpt: string;
  links: string[];
}

export interface WebsiteSignals {
  origin: string;
  pages: WebsitePageSignals[];
  titles: string[];
  meta_descriptions: string[];
  headings: string[];
  text_excerpt: string;
  discovered_paths: string[];
  truncated: boolean;
}

export interface WebsiteBundle {
  url: string;
  finalUrl: string;
  title: string | null;
  contentHash: string;
  signals: WebsiteSignals;
  screens: AppScreen[];
}

export async function ingestWebsite(
  input: string,
  opts: { fetchPage?: typeof fetchPublicHtml } = {},
): Promise<WebsiteBundle> {
  const fetchPage = opts.fetchPage ?? fetchPublicHtml;
  const start = canonicalWebsiteUrl(input);
  const home = await fetchPage(start);
  const origin = new URL(home.finalUrl).origin;
  const homeSignals = extractPage(home);

  const candidates = discoverExtraPaths(homeSignals, origin).slice(0, MAX_EXTRA_PAGES);
  const extras: WebsitePageSignals[] = [];
  let truncated = false;

  for (const path of candidates) {
    try {
      const target = `${origin}${path}`;
      await assertSafePublicUrl(target);
      const page = await fetchPage(target);
      // Stay same-origin after redirects.
      if (new URL(page.finalUrl).origin !== origin) continue;
      extras.push(extractPage(page));
    } catch (e) {
      truncated = true;
      log.info('skipped linked page', { path, error: String(e) });
    }
  }

  const pages = [homeSignals, ...extras];
  const headings = unique(pages.flatMap((p) => p.headings)).slice(0, MAX_HEADINGS);
  const titles = unique(pages.map((p) => p.title).filter(Boolean) as string[]);
  const metas = unique(pages.map((p) => p.meta_description).filter(Boolean) as string[]);
  const text_excerpt = pages
    .map((p) => p.text_excerpt)
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_TEXT_CHARS);

  const signals: WebsiteSignals = {
    origin,
    pages: pages.map((p) => ({
      ...p,
      // Keep evidence payloads compact for the model context.
      text_excerpt: p.text_excerpt.slice(0, 2_000),
      links: p.links.slice(0, 30),
    })),
    titles,
    meta_descriptions: metas,
    headings,
    text_excerpt,
    discovered_paths: pages.map((p) => safePath(p.url)),
    truncated,
  };

  const screens = headingsToScreens(headings, home.finalUrl);

  log.info('website ingested', {
    url: start,
    final: home.finalUrl,
    pages: pages.length,
    headings: headings.length,
  });

  return {
    url: start,
    finalUrl: home.finalUrl,
    title: homeSignals.title,
    contentHash: home.contentHash,
    signals,
    screens,
  };
}

function extractPage(page: FetchedPage): WebsitePageSignals {
  const html = page.body;
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const meta_description =
    metaContent(html, 'description') ||
    metaContent(html, 'og:description') ||
    metaProperty(html, 'og:description');
  const headings = [
    ...matchAll(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi),
    ...matchAll(html, /<h2[^>]*>([\s\S]*?)<\/h2>/gi),
    ...matchAll(html, /<h3[^>]*>([\s\S]*?)<\/h3>/gi),
  ]
    .map(stripTags)
    .map(collapseWs)
    .filter((h) => h.length >= 2 && h.length <= 160)
    .slice(0, MAX_HEADINGS);

  const links = collectSameOriginLinks(html, page.finalUrl);
  const text_excerpt = collapseWs(stripTags(stripScripts(html))).slice(0, MAX_TEXT_CHARS);

  return {
    url: page.finalUrl,
    title: title ? collapseWs(stripTags(title)).slice(0, 200) : null,
    meta_description: meta_description
      ? collapseWs(stripTags(meta_description)).slice(0, 500)
      : null,
    headings,
    text_excerpt,
    links,
  };
}

function discoverExtraPaths(home: WebsitePageSignals, origin: string): string[] {
  const linked = new Set<string>();
  for (const href of home.links) {
    try {
      const u = new URL(href, origin);
      if (u.origin !== origin) continue;
      const path = u.pathname.replace(/\/$/, '') || '/';
      if (path !== '/' && EXTRA_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) {
        linked.add(path.split('/').slice(0, 2).join('/') || path);
      }
    } catch {
      /* ignore bad hrefs */
    }
  }
  // Prefer linked pages; fall back to common marketing paths.
  const ordered = [
    ...EXTRA_PATHS.filter((p) => [...linked].some((l) => l === p || l.startsWith(`${p}/`))),
    ...EXTRA_PATHS.filter((p) => ![...linked].some((l) => l === p || l.startsWith(`${p}/`))),
  ];
  return unique(ordered).slice(0, MAX_EXTRA_PAGES);
}

function collectSameOriginLinks(html: string, baseUrl: string): string[] {
  const origin = new URL(baseUrl).origin;
  const hrefs = matchAll(html, /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi);
  const out: string[] = [];
  for (const href of hrefs) {
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      continue;
    }
    try {
      const u = new URL(href, baseUrl);
      if (u.origin === origin) out.push(u.href);
    } catch {
      /* ignore */
    }
  }
  return unique(out).slice(0, 80);
}

function headingsToScreens(headings: string[], pageUrl: string): AppScreen[] {
  return headings.slice(0, 8).map((name, i) => ({
    name: name.slice(0, 80),
    route: safePath(pageUrl),
    purpose: 'Section observed on the product website',
    key_elements: [name],
    workflow: null,
    image_url: null,
    source_file: `${pageUrl}#heading-${i + 1}`,
  }));
}

function metaContent(html: string, name: string): string | null {
  const re = new RegExp(
    `<meta\\b[^>]*\\bname\\s*=\\s*["']${escapeReg(name)}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*>`,
    'i',
  );
  const re2 = new RegExp(
    `<meta\\b[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\bname\\s*=\\s*["']${escapeReg(name)}["'][^>]*>`,
    'i',
  );
  return firstMatch(html, re) || firstMatch(html, re2);
}

function metaProperty(html: string, property: string): string | null {
  const re = new RegExp(
    `<meta\\b[^>]*\\bproperty\\s*=\\s*["']${escapeReg(property)}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*>`,
    'i',
  );
  const re2 = new RegExp(
    `<meta\\b[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\bproperty\\s*=\\s*["']${escapeReg(property)}["'][^>]*>`,
    'i',
  );
  return firstMatch(html, re) || firstMatch(html, re2);
}

function stripScripts(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function firstMatch(s: string, re: RegExp): string | null {
  const m = s.match(re);
  return m?.[1] ?? null;
}

function matchAll(s: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(re)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safePath(url: string): string {
  try {
    const u = parseWebsiteUrl(url);
    return u.pathname || '/';
  } catch {
    return '/';
  }
}
