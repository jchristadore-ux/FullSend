/**
 * Repository ingestion.
 *
 * Turns a repo into a compact bundle of signals: what it is built with, what
 * screens it has, what it claims in its README, and which images already exist
 * that can be used as creative. The bundle is small on purpose — it becomes the
 * cached prefix of every AI call for this project, so its size sets the cost.
 */
import 'server-only';
import { logger } from '../logger';
import type { AppScreen } from '../types';
import { discoverBrandIdentity, type BrandIdentity } from '../brand/discover';
import { GitHubClient, type RepoMeta, type RepoRef, type TreeEntry } from './client';

const log = logger('github.ingest');

export interface RepoSignals {
  languages: Record<string, number>;
  dependencies: string[];
  dev_dependencies: string[];
  scripts: string[];
  routes: string[];
  readme_summary: string;
  readme_headings: string[];
  /** Images already committed to the repo — usable creative, not guesses. */
  repo_images: { path: string; url: string; context: string }[];
  file_count: number;
  has_tests: boolean;
  has_ci: boolean;
  has_docs: boolean;
  config_files: string[];
  truncated: boolean;
  /** A deployed URL, when the repo declares one. A real capture target. */
  homepage: string | null;
}

export interface RepoBundle {
  meta: RepoMeta;
  signals: RepoSignals;
  screens: AppScreen[];
  /** The commit this bundle describes. The identity of an analysis. */
  commitSha: string | null;
  /**
   * What the repository says about how the product looks. Read, never
   * invented — a field no file answers arrives unresolved so the founder can
   * correct it, rather than as a guess they have no reason to doubt.
   */
  identity: BrandIdentity;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
const SCREENSHOT_HINT = /(screenshot|screen-?shot|preview|demo|hero|banner|ui|app-?shot|docs?\/)/i;
const SKIP_DIR =
  /(^|\/)(node_modules|\.git|dist|build|out|\.next|vendor|coverage|__pycache__|target|\.venv)(\/|$)/;

/** Candidate files we care about, in the order we would like to read them. */
const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'composer.json',
  'pubspec.yaml',
];

export async function ingestRepository(
  ref: RepoRef,
  client = new GitHubClient(),
): Promise<RepoBundle> {
  const meta = await client.getRepo(ref);
  const [languages, tree, readme, commitSha] = await Promise.all([
    client.getLanguages(ref),
    client.getTree(ref, meta.default_branch).catch(() => ({ entries: [], truncated: false })),
    client.getReadme(ref),
    headSha(client, ref, meta.default_branch),
  ]);

  const files = tree.entries.filter((e) => e.type === 'blob' && !SKIP_DIR.test(e.path));

  const manifestPath = MANIFESTS.find((m) => files.some((f) => f.path === m));
  const manifest = manifestPath ? await client.getFile(ref, manifestPath, meta.default_branch) : null;
  const { dependencies, devDependencies, scripts } = parseManifest(manifestPath, manifest);

  const routes = detectRoutes(files);
  const screens = await buildScreens(ref, client, meta, files, routes, readme);

  /*
   * Never allowed to fail the ingestion. A repository whose brand cannot be
   * read is still a product worth marketing; the founder fills the profile in
   * by hand, and every field arrives marked unresolved so they know to.
   */
  const identity = await discoverBrandIdentity(ref, client, meta.default_branch, files).catch(
    (e): BrandIdentity => {
      log.warn('brand discovery failed; the profile stays unknown rather than guessed', {
        repo: meta.full_name,
        error: String(e),
      });
      return {
        evidence: {
          style_files: [],
          color_tokens: [],
          font_families: [],
          logo_candidates: [],
          unresolved: ['primary_color', 'heading_font', 'body_font', 'logo_url'],
        },
      };
    },
  );

  const signals: RepoSignals = {
    languages,
    dependencies,
    dev_dependencies: devDependencies,
    scripts,
    routes,
    readme_summary: summariseReadme(readme),
    readme_headings: readmeHeadings(readme),
    repo_images: collectRepoImages(ref, client, meta, files, readme),
    file_count: files.length,
    has_tests: files.some((f) =>
      /(^|\/)(tests?|__tests__|spec)\//i.test(f.path) || /\.(test|spec)\.[jt]sx?$/.test(f.path),
    ),
    has_ci: files.some((f) => f.path.startsWith('.github/workflows/')),
    has_docs: files.some((f) => /^docs?\//i.test(f.path)),
    config_files: files
      .filter((f) => !f.path.includes('/') && /\.(json|ya?ml|toml|config\.[jt]s)$/.test(f.path))
      .map((f) => f.path)
      .slice(0, 20),
    truncated: tree.truncated,
    homepage: meta.homepage,
  };

  log.info('repository ingested', {
    repo: meta.full_name,
    files: files.length,
    routes: routes.length,
    screens: screens.length,
    images: signals.repo_images.length,
    brandUnresolved: identity.evidence.unresolved.length,
  });

  return { meta, signals, screens, commitSha, identity };
}

/**
 * The head commit, best effort.
 *
 * A client that cannot report it — an older stand-in, a token without the
 * scope — leaves the analysis unkeyed rather than unrunnable. Not knowing
 * which commit was analysed costs a re-analysis later; failing here would cost
 * the analysis entirely.
 */
async function headSha(
  client: GitHubClient,
  ref: RepoRef,
  branch: string,
): Promise<string | null> {
  if (typeof client.getHeadSha !== 'function') return null;
  try {
    return await client.getHeadSha(ref, branch);
  } catch {
    return null;
  }
}

/* ── Manifests ──────────────────────────────────────────────────────────── */

function parseManifest(
  path: string | undefined,
  content: string | null,
): { dependencies: string[]; devDependencies: string[]; scripts: string[] } {
  const empty = { dependencies: [], devDependencies: [], scripts: [] };
  if (!path || !content) return empty;

  if (path === 'package.json' || path === 'composer.json') {
    try {
      const pkg = JSON.parse(content);
      return {
        dependencies: Object.keys(pkg.dependencies ?? pkg.require ?? {}),
        devDependencies: Object.keys(pkg.devDependencies ?? pkg['require-dev'] ?? {}),
        scripts: Object.keys(pkg.scripts ?? {}),
      };
    } catch {
      return empty;
    }
  }
  if (path === 'requirements.txt') {
    return {
      ...empty,
      dependencies: content
        .split('\n')
        .map((l) => l.split(/[=<>!~\[;#]/)[0].trim())
        .filter((l) => l && !l.startsWith('-')),
    };
  }
  if (path === 'pyproject.toml' || path === 'Cargo.toml') {
    const deps = [...content.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)].map((m) => m[1]);
    return { ...empty, dependencies: [...new Set(deps)].slice(0, 60) };
  }
  if (path === 'go.mod') {
    const deps = [...content.matchAll(/^\s+([\w./-]+)\s+v/gm)].map((m) => {
      const parts = m[1].split('/');
      return parts[parts.length - 1];
    });
    return { ...empty, dependencies: [...new Set(deps)].slice(0, 60) };
  }
  if (path === 'Gemfile') {
    const deps = [...content.matchAll(/gem ['"]([^'"]+)['"]/g)].map((m) => m[1]);
    return { ...empty, dependencies: deps };
  }
  if (path === 'pubspec.yaml') {
    const deps = [...content.matchAll(/^\s{2}([a-z0-9_]+):/gm)].map((m) => m[1]);
    return { ...empty, dependencies: [...new Set(deps)].slice(0, 60) };
  }
  return empty;
}

/* ── Route / screen detection ───────────────────────────────────────────── */

/** Recognises the common router conventions rather than guessing from names. */
export function detectRoutes(files: TreeEntry[]): string[] {
  const routes = new Set<string>();

  for (const f of files) {
    const p = f.path;

    // Next.js App Router: app/**/page.tsx
    let m = p.match(/^(?:src\/)?app\/(.*)\/page\.(tsx?|jsx?|mdx)$/);
    if (m) {
      routes.add('/' + m[1].replace(/\(.*?\)\//g, '').replace(/@[^/]+\//g, ''));
      continue;
    }
    if (/^(?:src\/)?app\/page\.(tsx?|jsx?|mdx)$/.test(p)) {
      routes.add('/');
      continue;
    }
    // Next.js Pages Router
    m = p.match(/^(?:src\/)?pages\/(.*)\.(tsx?|jsx?|mdx)$/);
    if (m && !m[1].startsWith('_') && !m[1].startsWith('api/')) {
      routes.add('/' + m[1].replace(/\/index$/, '').replace(/^index$/, ''));
      continue;
    }
    // SvelteKit
    m = p.match(/^src\/routes\/(.*)\/\+page\.svelte$/);
    if (m) {
      routes.add('/' + m[1]);
      continue;
    }
    // Nuxt / Vue
    m = p.match(/^(?:src\/)?pages\/(.*)\.vue$/);
    if (m) {
      routes.add('/' + m[1].replace(/\/index$/, ''));
      continue;
    }
    // Convention-named React screens/views
    m = p.match(/^(?:src\/)?(?:screens|views|pages)\/([A-Za-z0-9_-]+)(?:\/index)?\.(tsx?|jsx?)$/);
    if (m) {
      routes.add('/' + kebab(m[1].replace(/(Screen|View|Page)$/, '')));
      continue;
    }
    // Django / Flask / Rails templates
    m = p.match(/^(?:.*\/)?templates\/(.+)\.html?$/);
    if (m) routes.add('/' + m[1].replace(/\/index$/, ''));
  }

  return [...routes]
    .map((r) => (r === '' ? '/' : r.replace(/\/+$/, '') || '/'))
    .filter((r, i, arr) => arr.indexOf(r) === i)
    .sort()
    .slice(0, 40);
}

function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Turns routes into described screens. Reads the source of the most promising
 * ones to pull out headings and button labels — the raw material for accurate
 * product-demo content.
 */
async function buildScreens(
  ref: RepoRef,
  client: GitHubClient,
  meta: RepoMeta,
  files: TreeEntry[],
  routes: string[],
  readme: string | null,
): Promise<AppScreen[]> {
  const images = collectRepoImages(ref, client, meta, files, readme);
  const interesting = routes
    .filter((r) => !r.includes('[') && !r.includes(':'))
    .slice(0, 8);

  /*
   * Fetched together rather than one after another.
   *
   * These were eight sequential round trips to GitHub, in the same serverless
   * invocation as the model call that follows them, under a sixty-second
   * ceiling. On a repository with real routes that is most of the budget spent
   * before the analysis starts — and an invocation killed here leaves a job
   * claimed and a stage that never reports back.
   */
  const sources = await Promise.all(
    interesting.map(async (route) => {
      const sourceFile = findSourceForRoute(files, route);
      if (!sourceFile) return { route, sourceFile: null, elements: [] as string[] };
      const src = await client.getFile(ref, sourceFile, meta.default_branch);
      return { route, sourceFile, elements: src ? extractUiElements(src) : [] };
    }),
  );

  const screens: AppScreen[] = [];
  for (const { route, sourceFile, elements } of sources) {
    const name = route === '/' ? 'Home' : titleize(route.split('/').filter(Boolean).pop() ?? route);
    screens.push({
      name,
      route,
      purpose: describeScreen(name, route, elements),
      key_elements: elements.slice(0, 8),
      workflow: elements.length >= 2 ? `${elements[0]} → ${elements[1]}` : null,
      // Only attach an image when one genuinely exists in the repo.
      image_url: matchImageToScreen(images, name, route),
      source_file: sourceFile,
    });
  }

  // A repo with no router still has screenshots worth building content around.
  if (screens.length === 0 && images.length) {
    for (const img of images.slice(0, 5)) {
      const name = titleize(
        img.path.split('/').pop()?.replace(IMAGE_RE, '').replace(/[-_]/g, ' ') ?? 'Screen',
      );
      screens.push({
        name,
        route: null,
        purpose: img.context || `${name} — from the repository's own screenshots.`,
        key_elements: [],
        workflow: null,
        image_url: img.url,
        source_file: img.path,
      });
    }
  }

  return screens;
}

function findSourceForRoute(files: TreeEntry[], route: string): string | null {
  const seg = route === '/' ? '' : route.replace(/^\//, '');
  const candidates = [
    `app/${seg}/page.tsx`,
    `src/app/${seg}/page.tsx`,
    `app/${seg}/page.jsx`,
    `pages/${seg}.tsx`,
    `src/pages/${seg}.tsx`,
    `src/routes/${seg}/+page.svelte`,
    `src/pages/${seg}.vue`,
  ].map((c) => c.replace(/\/{2,}/g, '/').replace(/\/page/, seg === '' ? 'page' : '/page'));

  for (const c of candidates) {
    const hit = files.find((f) => f.path === c);
    if (hit) return hit.path;
  }
  // Fall back to any file whose path contains the segment.
  if (seg) {
    const loose = files.find(
      (f) => f.path.includes(`/${seg}/`) && /\.(tsx?|jsx?|vue|svelte)$/.test(f.path),
    );
    if (loose) return loose.path;
  }
  return null;
}

/** Pulls visible strings — headings, buttons, labels — out of a component. */
export function extractUiElements(source: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim().replace(/\s+/g, ' ');
    if (
      t.length >= 2 &&
      t.length <= 48 &&
      !/^[{<$]/.test(t) &&
      !/^(https?:|\/|\.\/|#)/.test(t) &&
      !/[{}<>]/.test(t) &&
      /[a-zA-Z]/.test(t)
    ) {
      out.push(t);
    }
  };

  for (const m of source.matchAll(/<h[1-3][^>]*>([^<{]+)</g)) push(m[1]);
  for (const m of source.matchAll(/<button[^>]*>([^<{]+)</gi)) push(m[1]);
  for (const m of source.matchAll(/(?:label|title|placeholder|heading|aria-label)=["']([^"']+)["']/g))
    push(m[1]);
  // SwiftUI / Flutter style
  for (const m of source.matchAll(/Text\(\s*["']([^"']{2,48})["']/g)) push(m[1]);

  return [...new Set(out)].slice(0, 12);
}

function describeScreen(name: string, route: string, elements: string[]): string {
  if (elements.length) {
    return `${name} screen (${route}) — ${elements.slice(0, 3).join(', ')}.`;
  }
  return `${name} screen at ${route}.`;
}

function matchImageToScreen(
  images: { path: string; url: string }[],
  name: string,
  route: string,
): string | null {
  const key = name.toLowerCase();
  const seg = route.replace(/^\//, '').toLowerCase();
  const hit = images.find(
    (i) => i.path.toLowerCase().includes(key) || (seg && i.path.toLowerCase().includes(seg)),
  );
  return hit?.url ?? null;
}

function titleize(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/* ── README & images ────────────────────────────────────────────────────── */

function collectRepoImages(
  ref: RepoRef,
  client: GitHubClient,
  meta: RepoMeta,
  files: TreeEntry[],
  readme: string | null,
): { path: string; url: string; context: string }[] {
  const readmeImages = new Map<string, string>();
  if (readme) {
    // ![alt](path) and <img src="path" alt="...">
    for (const m of readme.matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)) {
      readmeImages.set(normalisePath(m[2]), m[1]);
    }
    for (const m of readme.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*alt=["']([^"']*)["']/g)) {
      readmeImages.set(normalisePath(m[1]), m[2]);
    }
  }

  const candidates = files
    .filter((f) => IMAGE_RE.test(f.path) && f.size > 8_000 && f.size < 12_000_000)
    .filter((f) => SCREENSHOT_HINT.test(f.path) || readmeImages.has(f.path))
    // Bigger files are more likely to be real screenshots than icons.
    .sort((a, b) => {
      const aIn = readmeImages.has(a.path) ? 1 : 0;
      const bIn = readmeImages.has(b.path) ? 1 : 0;
      if (aIn !== bIn) return bIn - aIn;
      return b.size - a.size;
    })
    .slice(0, 8);

  return candidates.map((f) => ({
    path: f.path,
    url: client.rawUrl(ref, meta.default_branch, f.path),
    context: readmeImages.get(f.path) ?? '',
  }));
}

function normalisePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\//, '').split('?')[0];
}

function summariseReadme(readme: string | null): string {
  if (!readme) return '';
  return readme
    .replace(/^---[\s\S]*?---\n/, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    // Badge rows carry no product meaning.
    .replace(/^[#>*\-\s]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

function readmeHeadings(readme: string | null): string[] {
  if (!readme) return [];
  const skip = /^(install|installation|getting started|licen[cs]e|contributing|usage|setup|table of contents|acknowledg|credits|roadmap|changelog|development|contribut)/i;
  return [...readme.matchAll(/^#{2,3}\s+(.+)$/gm)]
    .map((m) => m[1].replace(/[#*`]/g, '').trim())
    .filter((h) => h.length > 2 && h.length < 60 && !skip.test(h))
    .slice(0, 10);
}
