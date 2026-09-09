import { LIMITS, projectRoute } from '@/lib/api/handler';
import { z } from 'zod';
import { db, enqueueOnce, getAnalysis, getRepository } from '@/lib/db/repo';
import { parseRepoInput } from '@/lib/github/client';
import { screenshotAvailability } from '@/lib/analysis/analyze';
import { canonicalWebsiteUrl } from '@/lib/website/url';

export const runtime = 'nodejs';
export const maxDuration = 60;

export const GET = projectRoute(async ({ session, project }) => {
  const [repository, analysis, website] = await Promise.all([
    getRepository(session.scope, project.id),
    getAnalysis(session.scope, project.id),
    db().findOne(session.scope, 'website_sources', { where: { project_id: project.id } }),
  ]);
  const personas = analysis ? await db().find(session.scope, 'personas', { where: { project_id: project.id }, orderBy: 'priority', direction: 'asc' }) : [];
  const jobs = await db().find(session.scope, 'jobs', { where: { project_id: project.id }, orderBy: 'created_at', direction: 'desc', limit: 10 });
  const analyzeJob = jobs.find((j) => j.type === 'analyze_repository');
  const strategyJob = jobs.find((j) => j.type === 'generate_strategy');
  return {
    status: project.status,
    source_type: project.source_type,
    website_url: project.website_url,
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
    if (project.source_type === 'website' || body.website_url) {
      const websiteUrl = body.website_url
        ? canonicalWebsiteUrl(body.website_url)
        : project.website_url;
      if (!websiteUrl) {
        return { error: 'no_website', message: 'No website is attached to this project' };
      }
      const refresh = Boolean(body.refresh || body.website_url);
      const idempotencyKey = `${project.id}:analysis:website:${websiteUrl}:${refresh ? 'refresh' : 'reuse'}`;
      const { job, created } = await enqueueOnce(
        session.scope,
        'analyze_repository',
        { projectId: project.id, websiteUrl, refresh, idempotencyKey },
        { projectId: project.id, dedupeKey: idempotencyKey },
      );
      return { jobId: job.id, status: created ? 'queued' : job.status, refresh };
    }

    const repository = body.repository
      ? parseRepoInput(body.repository)
      : await getRepository(session.scope, project.id).then((r) => r ? { owner: r.owner, name: r.name } : null);
    if (!repository) return { error: 'no_repository', message: 'No repository is attached to this project' };

    const refresh = Boolean(body.refresh || body.repository);
    const idempotencyKey = `${project.id}:analysis:${repository.owner}/${repository.name}:${refresh ? 'refresh' : 'reuse'}`;
    const { job, created } = await enqueueOnce(
      session.scope,
      'analyze_repository',
      { projectId: project.id, repository: `${repository.owner}/${repository.name}`, refresh, idempotencyKey },
      { projectId: project.id, dedupeKey: idempotencyKey },
    );
    return { jobId: job.id, status: created ? 'queued' : job.status, refresh };
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
