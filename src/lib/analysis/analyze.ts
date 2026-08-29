/**
 * Product understanding.
 *
 * Reads a repository and produces FullSend's model of the app: what it is, who
 * needs it, what it can honestly claim, and which screens are worth filming.
 * The `not_capabilities` list it produces is what quality control later uses to
 * stop content overclaiming.
 */
import 'server-only';
import { generateObject } from '../ai/client';
import { systemScope, type TenantScope } from '../db';
import { db, getRepository } from '../db/repo';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import { GitHubClient, parseRepoInput } from '../github/client';
import { ingestRepository, type RepoBundle } from '../github/ingest';
import { personasSchema, productAnalysisSchema } from '../schemas';
import type { Persona, ProductAnalysis, Project, Repository, Uuid } from '../types';

const log = logger('analysis');

const ANALYST_SYSTEM = `You are FullSend's product analyst.

You are given a real GitHub repository: its metadata, dependency manifest, file
tree signals, detected routes, and README. Your job is to work out what the
product actually is, so that everything FullSend markets about it is true.

Rules that matter more than eloquence:
- Only list a feature if the supplied evidence supports it. Cite the evidence.
- If the repository does not show something, it is not a feature.
- Fill "not_capabilities" with things the product plausibly gets confused with
  but does NOT do, plus any claim category that cannot be substantiated
  (performance numbers, user counts, revenue, integrations not in the manifest).
- "confidence" is a number between 0 and 1, and should be honest: a thin README
  and no routes means something around 0.3, not 0.9. Never a word, never a
  percentage — 0.35, not "low" and not "35%".
- Write "one_liner" the way the founder would say it out loud, not as marketing copy.

Return JSON only.`;

const PERSONA_SYSTEM = `You are FullSend's audience researcher.

Given a verified product analysis, identify the two to four people who would
actually use this. Be specific and unglamorous: real roles, real frustrations,
real objections. Avoid demographic filler ("25-40, urban, tech-savvy").

Every pain point must be one this product genuinely addresses.

Return JSON only.`;

export interface AnalyzeResult {
  repository: Repository;
  analysis: ProductAnalysis;
  personas: Persona[];
  costUsd: number;
}

export async function analyzeRepository(
  scope: TenantScope,
  project: Project,
  repositoryInput: string,
  opts: { githubToken?: string; client?: GitHubClient } = {},
): Promise<AnalyzeResult> {
  const ref = parseRepoInput(repositoryInput);
  const client = opts.client ?? new GitHubClient(opts.githubToken);

  log.info('analysing repository', { project: project.id, repo: `${ref.owner}/${ref.name}` });
  const bundle = await ingestRepository(ref, client);

  const repository = await upsertRepository(scope, project.id, bundle);
  const { analysis, cost: analysisCost } = await runAnalysis(scope, project, repository, bundle);
  const { personas, cost: personaCost } = await runPersonas(scope, project, analysis);

  return { repository, analysis, personas, costUsd: analysisCost + personaCost };
}

async function upsertRepository(
  scope: TenantScope,
  projectId: Uuid,
  bundle: RepoBundle,
): Promise<Repository> {
  const { meta, signals } = bundle;
  const existing = await getRepository(scope, projectId);
  const patch = {
    owner: meta.owner,
    name: meta.name,
    url: meta.html_url,
    default_branch: meta.default_branch,
    description: meta.description,
    primary_language: meta.language,
    languages: signals.languages,
    topics: meta.topics,
    stars: meta.stargazers_count,
    is_private: meta.private,
    last_indexed_at: nowIso(),
  };
  if (existing) return db().update(scope, 'repositories', existing.id, patch);
  return db().insert(scope, 'repositories', {
    id: newId(),
    project_id: projectId,
    provider: 'github',
    created_at: nowIso(),
    ...patch,
  });
}

async function runAnalysis(
  scope: TenantScope,
  project: Project,
  repository: Repository,
  bundle: RepoBundle,
): Promise<{ analysis: ProductAnalysis; cost: number }> {
  const { data, costUsd } = await generateObject({
    task: 'analysis.product',
    system: ANALYST_SYSTEM,
    brief: `Work out what ${bundle.meta.full_name} actually is.`,
    context: {
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
    },
    schema: productAnalysisSchema,
    attribution: { scope, projectId: project.id, userId: project.user_id },
  });

  const analysis = await db().insert(scope, 'product_analysis', {
    id: newId(),
    project_id: project.id,
    repository_id: repository.id,
    one_liner: data.one_liner,
    what_it_does: data.what_it_does,
    category: data.category,
    features: data.features,
    not_capabilities: data.not_capabilities,
    tech_stack: data.tech_stack,
    platforms: data.platforms,
    target_market: data.target_market,
    problem_solved: data.problem_solved,
    differentiators: data.differentiators,
    maturity: data.maturity,
    // Screens come from the repository itself, never from the model.
    screens: bundle.screens,
    confidence: data.confidence,
    raw_signals: {
      repo_images: bundle.signals.repo_images,
      truncated: bundle.signals.truncated,
      homepage: bundle.signals.homepage,
      file_count: bundle.signals.file_count,
    },
    created_at: nowIso(),
  });

  return { analysis, cost: costUsd };
}

async function runPersonas(
  scope: TenantScope,
  project: Project,
  analysis: ProductAnalysis,
): Promise<{ personas: Persona[]; cost: number }> {
  const { data, costUsd } = await generateObject({
    task: 'analysis.personas',
    system: PERSONA_SYSTEM,
    brief: `Who actually uses ${analysis.one_liner}?`,
    context: {
      analysis: {
        one_liner: analysis.one_liner,
        what_it_does: analysis.what_it_does,
        category: analysis.category,
        features: analysis.features,
        target_market: analysis.target_market,
        problem_solved: analysis.problem_solved,
        differentiators: analysis.differentiators,
      },
    },
    schema: personasSchema,
    attribution: { scope, projectId: project.id, userId: project.user_id },
  });

  // Replace rather than accumulate: re-analysis should not duplicate personas.
  const existing = await db().find(scope, 'personas', { where: { project_id: project.id } });
  for (const p of existing) await db().remove(scope, 'personas', p.id);

  const personas = await db().insertMany(
    scope,
    'personas',
    data.personas.map((p, i) => ({
      id: newId(),
      project_id: project.id,
      name: p.name,
      role: p.role,
      description: p.description,
      pain_points: p.pain_points,
      goals: p.goals,
      objections: p.objections,
      where_they_hang_out: p.where_they_hang_out.length ? p.where_they_hang_out : ['instagram' as const, 'tiktok' as const],
      tone_preference: p.tone_preference,
      priority: p.priority || i + 1,
      created_at: nowIso(),
    })),
  );

  return { personas, cost: costUsd };
}

/**
 * Screens FullSend can genuinely build demo content around, split by what is
 * actually available. Nothing here pretends a screenshot exists when it doesn't.
 */
export function screenshotAvailability(analysis: ProductAnalysis): {
  withImages: number;
  describedOnly: number;
  liveCaptureTarget: string | null;
  note: string;
} {
  const withImages = analysis.screens.filter((s) => s.image_url).length;
  const describedOnly = analysis.screens.length - withImages;
  const homepage = (analysis.raw_signals as any)?.homepage ?? null;
  return {
    withImages,
    describedOnly,
    liveCaptureTarget: homepage,
    note: withImages
      ? `${withImages} screenshot${withImages === 1 ? '' : 's'} found in the repository and ready to use as creative.`
      : homepage
        ? `No screenshots committed to the repo. ${homepage} is set as the homepage and can be captured for demo creative.`
        : 'No screenshots in the repo and no homepage set. Demo content will be built from the described screens; add screenshots to the repo or set a homepage to get real product visuals.',
  };
}

/** Used by the onboarding progress stream. */
export const ANALYSIS_STEPS = [
  'Reading repository',
  'Understanding product',
  'Identifying audience',
  'Finding differentiators',
  'Building positioning',
  'Creating content strategy',
  'Planning first campaign',
] as const;

export async function systemAnalyze(
  project: Project,
  repositoryInput: string,
  githubToken?: string,
): Promise<AnalyzeResult> {
  return analyzeRepository(systemScope('background analysis'), project, repositoryInput, {
    githubToken,
  });
}
