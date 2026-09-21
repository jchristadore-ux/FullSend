/**
 * No-signup interactive demo.
 *
 * Reads a public GitHub repository or a public website, composes product
 * intelligence and one sample Instagram post, then stops at publish. Nothing is
 * persisted — the output is the sales asset, not a tenant project.
 *
 * Websites go through the SSRF guard. Private GitHub repositories are refused.
 * Callers must rate-limit heavily (see /api/demo).
 */
import 'server-only';
import { z } from 'zod';
import { DeterministicProvider } from '../ai/deterministic-provider';
import { FullSendError } from '../errors';
import { GitHubClient, parseRepoInput } from '../github/client';
import { ingestRepository } from '../github/ingest';
import { productAnalysisSchema } from '../schemas';
import { assertSafePublicUrl } from '../website/ssrf';
import { ingestWebsite } from '../website/ingest';

const samplePostSchema = z.object({
  hook: z.string(),
  caption: z.string(),
  cta: z.string().default(''),
  hashtags: z.array(z.string()).default([]),
  format: z.string().default('reel'),
  platform: z.literal('instagram').default('instagram'),
});

export type DemoAnalysis = z.infer<typeof productAnalysisSchema>;
export type DemoSamplePost = z.infer<typeof samplePostSchema>;

export interface DemoResult {
  source: {
    kind: 'github' | 'website';
    label: string;
    url: string;
  };
  analysis: DemoAnalysis;
  samplePost: DemoSamplePost;
  /** Always true — the demo never publishes. */
  publishBlocked: true;
  publishWall: {
    title: string;
    body: string;
    ctaLabel: string;
    ctaHref: string;
  };
  provider: string;
}

const PUBLISH_WALL = {
  title: 'Publishing is the wall',
  body:
    'That was a real read of your product and a real sample post. Sign in to connect Instagram, approve the plan, fill the calendar, and publish for real. Instagram is production today; TikTok is on the roadmap, not a production claim.',
  ctaLabel: 'Start free →',
  ctaHref: '/login?next=/onboarding',
} as const;

function looksLikeGithub(raw: string): boolean {
  const t = raw.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) return true;
  try {
    const u = new URL(t.startsWith('http') ? t : `https://${t}`);
    return /(^|\.)github\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function looksLikeWebsite(raw: string): boolean {
  const t = raw.trim();
  if (!t || looksLikeGithub(t)) return false;
  try {
    const u = new URL(t.startsWith('http') ? t : `https://${t}`);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function composeAnalysis(context: Record<string, unknown>): Promise<DemoAnalysis> {
  const provider = new DeterministicProvider();
  const response = await provider.complete({
    task: 'analysis.product',
    tier: 'standard',
    system: 'Compose product intelligence from the supplied repository or website signals.',
    messages: [{ role: 'user', content: JSON.stringify({ context }) }],
    noCache: true,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(response.text);
  } catch {
    throw new FullSendError('demo_compose_failed', 'Demo composer returned unreadable output', {
      status: 502,
      remedy: 'Try again in a moment, or sign in and run a full analysis.',
    });
  }
  const parsed = productAnalysisSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FullSendError('demo_compose_failed', 'Could not compose product intelligence from that source', {
      status: 502,
      remedy: 'Try a public repo with a README, or a public product homepage.',
      meta: { issues: parsed.error.issues.slice(0, 3) },
    });
  }
  return parsed.data;
}

function samplePostFromAnalysis(analysis: DemoAnalysis, productName: string): DemoSamplePost {
  const feature = analysis.features[0]?.name ?? analysis.category;
  const hook =
    analysis.one_liner.length > 8 ? analysis.one_liner : `${productName} — ${feature}`;
  const body = [
    analysis.what_it_does.slice(0, 280),
    analysis.features.length
      ? `What it actually does: ${analysis.features
          .slice(0, 3)
          .map((f) => f.name)
          .join(', ')}.`
      : null,
    analysis.not_capabilities.length
      ? `What we will never claim: ${analysis.not_capabilities[0]}.`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');
  const caption = `${hook}\n\n${body}\n\nLink in bio.`;
  const tag = analysis.category.replace(/[^a-z0-9]+/gi, '').slice(0, 24) || 'startup';
  return samplePostSchema.parse({
    hook,
    caption: caption.slice(0, 2200),
    cta: 'Link in bio',
    hashtags: ['#buildinpublic', '#indiehacker', '#saas', `#${tag}`],
    format: 'reel',
    platform: 'instagram',
  });
}

async function runGithubDemo(input: string): Promise<DemoResult> {
  const ref = parseRepoInput(input);
  const client = new GitHubClient();
  const meta = await client.getRepo(ref);
  if (meta.private) {
    throw new FullSendError('demo_private_repo', 'That repository is private', {
      status: 400,
      remedy: 'Paste a public GitHub URL for the demo. Private repos work after you sign in.',
    });
  }
  const bundle = await ingestRepository(ref, client);
  const analysis = await composeAnalysis({
    repository: {
      name: bundle.meta.name,
      owner: bundle.meta.owner,
      description: bundle.meta.description,
      topics: bundle.meta.topics,
      stars: bundle.meta.stargazers_count,
      homepage: bundle.meta.homepage,
      license: bundle.meta.license,
    },
    signals: {
      languages: bundle.signals.languages,
      dependencies: bundle.signals.dependencies.slice(0, 60),
      scripts: bundle.signals.scripts,
      routes: bundle.signals.routes,
      readme_summary: bundle.signals.readme_summary,
      readme_headings: bundle.signals.readme_headings,
      file_count: bundle.signals.file_count,
      has_tests: bundle.signals.has_tests,
      has_ci: bundle.signals.has_ci,
      config_files: bundle.signals.config_files,
    },
    detected_screens: bundle.screens.map((s) => ({
      name: s.name,
      route: s.route,
      elements: s.key_elements,
    })),
  });
  return {
    source: {
      kind: 'github',
      label: bundle.meta.full_name,
      url: bundle.meta.html_url,
    },
    analysis,
    samplePost: samplePostFromAnalysis(analysis, bundle.meta.name),
    publishBlocked: true,
    publishWall: { ...PUBLISH_WALL },
    provider: 'deterministic',
  };
}

async function runWebsiteDemo(input: string): Promise<DemoResult> {
  const safe = await assertSafePublicUrl(input.startsWith('http') ? input : `https://${input}`);
  const bundle = await ingestWebsite(safe.href);
  const analysis = await composeAnalysis({
    website: {
      url: bundle.url,
      final_url: bundle.finalUrl,
      title: bundle.title,
    },
    signals: {
      headings: bundle.signals.headings,
      titles: bundle.signals.titles,
      meta_descriptions: bundle.signals.meta_descriptions,
      text_excerpt: bundle.signals.text_excerpt,
      discovered_paths: bundle.signals.discovered_paths,
    },
  });
  const host = new URL(bundle.finalUrl).hostname.replace(/^www\./, '');
  return {
    source: {
      kind: 'website',
      label: bundle.title || host,
      url: bundle.finalUrl,
    },
    analysis,
    samplePost: samplePostFromAnalysis(analysis, host),
    publishBlocked: true,
    publishWall: { ...PUBLISH_WALL },
    provider: 'deterministic',
  };
}

/** Run the public demo against a GitHub URL (preferred) or a public website. */
export async function runDemo(rawInput: string): Promise<DemoResult> {
  const input = rawInput.trim();
  if (input.length < 3) {
    throw new FullSendError('demo_empty', 'Paste a public GitHub repository or website URL', {
      status: 400,
      remedy: 'Example: https://github.com/vercel/next.js or https://example.com',
    });
  }
  if (looksLikeGithub(input)) return runGithubDemo(input);
  if (looksLikeWebsite(input)) return runWebsiteDemo(input);
  throw new FullSendError(
    'demo_bad_source',
    'Paste a public GitHub repository (owner/repo) or an https:// website',
    {
      status: 400,
      remedy: 'GitHub example: vercel/next.js — Website example: https://yourproduct.com',
    },
  );
}
