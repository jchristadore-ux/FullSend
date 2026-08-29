import { LIMITS, projectRoute } from '@/lib/api/handler';
import { z } from 'zod';
import { db, enqueue, getAnalysis, getRepository } from '@/lib/db/repo';
import { parseRepoInput } from '@/lib/github/client';
import { screenshotAvailability, ANALYSIS_STEPS } from '@/lib/analysis/analyze';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Analysis state, polled by the onboarding progress screen. */
export const GET = projectRoute(async ({ session, project }) => {
  const [repository, analysis] = await Promise.all([
    getRepository(session.scope, project.id),
    getAnalysis(session.scope, project.id),
  ]);

  const personas = analysis
    ? await db().find(session.scope, 'personas', {
        where: { project_id: project.id },
        orderBy: 'priority',
        direction: 'asc',
      })
    : [];

  const jobs = await db().find(session.scope, 'jobs', {
    where: { project_id: project.id },
    orderBy: 'created_at',
    direction: 'desc',
    limit: 5,
  });
  const analyzeJob = jobs.find((j) => j.type === 'analyze_repository');
  const audienceJob = jobs.find((j) => j.type === 'identify_audience');
  const strategyJob = jobs.find((j) => j.type === 'generate_strategy');

  return {
    status: project.status,
    steps: ANALYSIS_STEPS,
    repository,
    analysis,
    personas,
    screenshots: analysis ? screenshotAvailability(analysis) : null,
    jobs: {
      // `attempts` matters: a requeued failure still reads as `queued`, and
      // without it the progress screen cannot tell a slow job from a broken one.
      analyze: analyzeJob
        ? { status: analyzeJob.status, attempts: analyzeJob.attempts, error: analyzeJob.last_error }
        : null,
      audience: audienceJob
        ? {
            status: audienceJob.status,
            attempts: audienceJob.attempts,
            error: audienceJob.last_error,
          }
        : null,
      strategy: strategyJob
        ? { status: strategyJob.status, attempts: strategyJob.attempts, error: strategyJob.last_error }
        : null,
    },
  };
});

/** Re-runs analysis, e.g. after the repo has moved on. */
export const POST = projectRoute(
  async ({ session, project, body }) => {
    const repository = body.repository
      ? parseRepoInput(body.repository)
      : await getRepository(session.scope, project.id).then((r) =>
          r ? { owner: r.owner, name: r.name } : null,
        );

    if (!repository) {
      return { error: 'no_repository', message: 'No repository is attached to this project' };
    }

    /*
     * Pressing the button again resumes: whatever already succeeded is kept
     * and only the steps that did not run again. A fresh start is asked for
     * explicitly — by naming a repository (it has moved on) or by `refresh`.
     */
    const refresh = Boolean(body.refresh || body.repository);

    const job = await enqueue(
      session.scope,
      'analyze_repository',
      { projectId: project.id, repository: `${repository.owner}/${repository.name}`, refresh },
      { projectId: project.id },
    );
    return { jobId: job.id, status: 'queued', refresh };
  },
  {
    schema: z.object({
      repository: z.string().min(3).max(300).optional(),
      refresh: z.boolean().optional(),
    }),
    rateLimit: LIMITS.analyze,
    rateLimitKey: 'analyze',
  },
);
