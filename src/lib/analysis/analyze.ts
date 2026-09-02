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
import { db, getAnalysis, getRepository } from '../db/repo';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import { GitHubClient, parseRepoInput } from '../github/client';
import { ingestRepository, type RepoBundle } from '../github/ingest';
import { productAnalysisSchema } from '../schemas';
import type { ProductAnalysis, Project, Repository, Uuid } from '../types';

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

export interface AnalyzeResult {
  repository: Repository;
  analysis: ProductAnalysis;
  costUsd: number;
  /** Which stages actually ran. The rest were already done and were reused. */
  ran: { ingest: boolean; analysis: boolean };
}

export interface ProductResult {
  repository: Repository;
  analysis: ProductAnalysis;
  costUsd: number;
  ran: { ingest: boolean; analysis: boolean };
}

/**
 * Step one: read the repository and work out what the product is.
 *
 * This is deliberately half of what it used to be. Ingest, product analysis
 * and audience ran as one unit inside a single serverless invocation with a
 * sixty-second ceiling — two sequential model calls and a GitHub crawl, which
 * on a real repository does not fit. The invocation was killed part-way, the
 * job row was left `running` with a lock nobody would break for ten minutes,
 * and the progress screen sat on one step with nothing failing and nothing
 * finishing. Splitting the work is what stops that: each job now does one
 * model call and returns well inside the limit.
 *
 * It is also checkpointed. A repeat run reuses a saved analysis and never
 * reads GitHub again — the ingest exists to feed the analysis, so there is
 * nothing to ingest for once that analysis is saved. `refresh` is the
 * deliberate re-analysis: the repository has moved on and the old
 * understanding should be replaced rather than reused.
 */
export async function analyzeProduct(
  scope: TenantScope,
  project: Project,
  repositoryInput: string,
  opts: { githubToken?: string; client?: GitHubClient; refresh?: boolean } = {},
): Promise<ProductResult> {
  const repository = opts.refresh ? null : await getRepository(scope, project.id);
  const analysis = opts.refresh ? null : await getAnalysis(scope, project.id);

  const ref = parseRepoInput(repositoryInput);
  const client = opts.client ?? new GitHubClient(opts.githubToken);

  if (repository && analysis && analysis.repository_id === repository.id) {
    /*
     * An analysis is identified by the commit it was derived from.
     *
     * The same commit always describes the same product, so a refreshed page,
     * a retried job or a second press of Analyze must never pay for it again.
     * A commit that has moved on is a different product to understand, and
     * gets its own version rather than overwriting the old one.
     *
     * When the head cannot be read — no token, GitHub unreachable, a client
     * that cannot report it — the saved analysis is reused. Not knowing is a
     * reason to keep what is on disk, never to spend on a fresh one.
     */
    const head = await headCommit(client, ref, repository.default_branch);
    const sameCommit = !head || !analysis.commit_sha || analysis.commit_sha === head;
    if (sameCommit) {
      log.info('reusing the existing product analysis', {
        project: project.id,
        commit: analysis.commit_sha ?? 'unknown',
      });
      return { repository, analysis, costUsd: 0, ran: { ingest: false, analysis: false } };
    }
    log.info('repository has moved on; analysing the new commit', {
      project: project.id,
      from: analysis.commit_sha,
      to: head,
    });
  }

  log.info('analysing repository', { project: project.id, repo: `${ref.owner}/${ref.name}` });

  const bundle = await ingestRepository(ref, client);
  const saved = await upsertRepository(scope, project.id, bundle);
  const result = await runAnalysis(scope, project, saved, bundle);

  return {
    repository: saved,
    analysis: result.analysis,
    costUsd: result.cost,
    ran: { ingest: true, analysis: true },
  };
}

/**
 * The analysis stage, whole.
 *
 * There used to be a second half: a model call that named two to four personas
 * before the marketing plan could be built. It is gone. The product analysis
 * already carries the target market, the problem solved and the
 * differentiators, so the personas mostly restated what was already known —
 * while adding a stage that could fail and stop everything behind it. Plans are
 * built from the analysis directly.
 */
export async function analyzeRepository(
  scope: TenantScope,
  project: Project,
  repositoryInput: string,
  opts: { githubToken?: string; client?: GitHubClient; refresh?: boolean } = {},
): Promise<AnalyzeResult> {
  const product = await analyzeProduct(scope, project, repositoryInput, opts);
  return {
    repository: product.repository,
    analysis: product.analysis,
    costUsd: product.costUsd,
    ran: product.ran,
  };
}

/** The head commit, or null when it cannot be read. Never throws. */
async function headCommit(
  client: GitHubClient,
  ref: { owner: string; name: string },
  branch: string,
): Promise<string | null> {
  if (typeof client.getHeadSha !== 'function') return null;
  try {
    return await client.getHeadSha(ref, branch);
  } catch {
    return null;
  }
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
    commit_sha: bundle.commitSha,
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
      /*
       * The product's own visual identity, read from its stylesheets rather
       * than asked of a model. It rides on the analysis because it is a fact
       * about this commit: re-reading the same commit would read the same
       * colours, and the brand build downstream needs them without going back
       * to GitHub.
       */
      brand_identity: bundle.identity,
    },
    // The commit this understanding was derived from. The same commit is never
    // analysed twice; a different one is a new version rather than an edit.
    commit_sha: bundle.commitSha,
    created_at: nowIso(),
  });

  return { analysis, cost: costUsd };
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

export async function systemAnalyze(
  project: Project,
  repositoryInput: string,
  githubToken?: string,
  opts: { refresh?: boolean } = {},
): Promise<AnalyzeResult> {
  return analyzeRepository(systemScope('background analysis'), project, repositoryInput, {
    githubToken,
    refresh: opts.refresh,
  });
}

/** Step one only. What the `analyze_repository` job runs. */
export async function systemAnalyzeProduct(
  project: Project,
  repositoryInput: string,
  githubToken?: string,
  opts: { refresh?: boolean } = {},
): Promise<ProductResult> {
  return analyzeProduct(systemScope('background analysis'), project, repositoryInput, {
    githubToken,
    refresh: opts.refresh,
  });
}
