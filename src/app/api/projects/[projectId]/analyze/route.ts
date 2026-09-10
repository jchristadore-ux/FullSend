import { LIMITS, projectRoute } from '@/lib/api/handler';
import { z } from 'zod';
import { db, enqueueOnce, getAnalysis, getRepository, getWebsiteSource } from '@/lib/db/repo';
import { parseRepoInput } from '@/lib/github/client';
import { screenshotAvailability } from '@/lib/analysis/analyze';
import { canonicalWebsiteUrl } from '@/lib/website/url';
import { healProjectSource, resolveProjectSource } from '@/lib/pipeline/source';

export const runtime = 'nodejs';
export const maxDuration = 60;

export const GET = projectRoute(async ({ session, project }) => {
  /*
   * The source is resolved rather than read straight off the row, so a project
   * whose `source_type` could not be stored (created while migration 0007 was
   * pending) still reports the website it was created with.
   */
  const source = await resolveProjectSource(session.scope, project);

  const [repository, analysis, website] = await Promise.all([
    getRepository(session.scope, project.id),
    getAnalysis(session.scope, project.id),
    /*
     * Only read for a project that has one. Reading it unconditionally put
     * every GitHub project's analysis state through a table that only exists
     * after migration 0007 — so on a deployment whose migration had not been
     * applied, this endpoint failed for projects that predate the feature.
     * `getWebsiteSource` also tolerates the missing table.
     */
    source.kind === 'website'
      ? getWebsiteSource(session.scope, project.id)
      : Promise.resolve(null),
  ]);
  const personas = analysis ? await db().find(session.scope, 'personas', { where: { project_id: project.id }, orderBy: 'priority', direction: 'asc' }) : [];
  const jobs = await db().find(session.scope, 'jobs', { where: { project_id: project.id }, orderBy: 'created_at', direction: 'desc', limit: 10 });
  const analyzeJob = jobs.find((j) => j.type === 'analyze_repository');
  const strategyJob = jobs.find((j) => j.type === 'generate_strategy');
  return {
    status: project.status,
    source_type: source.kind === 'website' ? 'website' : 'github',
    website_url: source.kind === 'website' ? source.url : null,
    repository,
    website,
    analysis,
    personas,
    screenshots: analysis ? screenshotAvailability(analysis) : null,
    jobs: {
      analyze: analyzeJob ? { status: analyzeJob.status, attempts: analyzeJob.attempts, error: analyzeJob.last_error } : null,
      strategy: strategyJob ? { status: strategyJob.status, attempts: strategyJob.attempts, error: strategyJob.last_error } : null,
    },
  };
});

export const POST = projectRoute(
  async ({ session, project, body }) => {
    /*
     * Re-analysing used to trust `project.source_type` alone, which sends a
     * website project stored without it down the GitHub path to
     * "No repository is attached to this project" — a dead end on a project
     * the founder created by pasting a URL, with no way out from the UI. The
     * source is resolved from the project's own history instead, and written
     * back to the row as soon as the schema can hold it.
     */
    const { project: healed, source } = body.website_url
      ? { project, source: { kind: 'website' as const, url: canonicalWebsiteUrl(body.website_url) } }
      : await healProjectSource(session.scope, project);

    if (source.kind === 'website') {
      const websiteUrl = source.url;
      const refresh = Boolean(body.refresh || body.website_url);
      const idempotencyKey = `${healed.id}:analysis:website:${websiteUrl}:${refresh ? 'refresh' : 'reuse'}`;
      const { job, created } = await enqueueOnce(
        session.scope,
        'analyze_repository',
        { projectId: healed.id, websiteUrl, refresh, idempotencyKey },
        { projectId: healed.id, dedupeKey: idempotencyKey },
      );
      return { jobId: job.id, status: created ? 'queued' : job.status, refresh, source: 'website' };
    }

    const repository = body.repository
      ? parseRepoInput(body.repository)
      : source.kind === 'github'
        ? parseRepoInput(source.repository)
        : null;
    if (!repository) return { error: 'no_source', message: 'No repository or website is attached to this project' };

    const refresh = Boolean(body.refresh || body.repository);
    const idempotencyKey = `${healed.id}:analysis:${repository.owner}/${repository.name}:${refresh ? 'refresh' : 'reuse'}`;
    const { job, created } = await enqueueOnce(
      session.scope,
      'analyze_repository',
      { projectId: healed.id, repository: `${repository.owner}/${repository.name}`, refresh, idempotencyKey },
      { projectId: healed.id, dedupeKey: idempotencyKey },
    );
    return { jobId: job.id, status: created ? 'queued' : job.status, refresh, source: 'github' };
  },
  {
    schema: z.object({
      repository: z.string().min(3).max(300).optional(),
      website_url: z.string().min(3).max(2048).optional(),
      refresh: z.boolean().optional(),
    }),
    rateLimit: LIMITS.analyze,
    rateLimitKey: 'analyze',
  },
);
