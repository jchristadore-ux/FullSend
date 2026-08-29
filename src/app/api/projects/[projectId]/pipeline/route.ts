import { LIMITS, projectRoute } from '@/lib/api/handler';
import { z } from 'zod';
import { enqueueOnce } from '@/lib/db/repo';
import { pipelineState, stagePayload, STAGE_ENTRY_JOB, type StageName } from '@/lib/pipeline/state';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** The four checkpoints and where the pipeline actually is. */
export const GET = projectRoute(async ({ session, project }) => {
  return pipelineState(session.scope, project);
});

/**
 * Restarts one stage, and only that stage.
 *
 * Everything already saved stays saved: the stage handlers reuse their own
 * checkpoints, so a retry of `content` does not rebuild the marketing plan and
 * a retry of `schedule` does not rewrite the content. `refresh` is the
 * deliberate regeneration — it is the only way to pay for a completed stage
 * twice.
 */
export const POST = projectRoute(
  async ({ session, project, body }) => {
    const stage = body.stage as StageName;
    const state = await pipelineState(session.scope, project);
    const target = state.stages.find((s) => s.name === stage);
    if (!target) return { error: 'unknown_stage', message: `No stage named "${stage}"` };

    if (target.status === 'complete' && !body.refresh) {
      return { stage, started: false, reason: 'Already complete. Nothing was re-run.', state };
    }
    if (target.status === 'in_progress') {
      return { stage, started: false, reason: 'Already running.', state };
    }

    const payload = await stagePayload(session.scope, project, stage);
    const { created } = await enqueueOnce(
      session.scope,
      STAGE_ENTRY_JOB[stage],
      { ...payload, refresh: Boolean(body.refresh) },
      { projectId: project.id },
    );

    return {
      stage,
      started: created,
      reason: created ? 'Queued.' : 'Already queued.',
      state: await pipelineState(session.scope, project),
    };
  },
  {
    schema: z.object({
      stage: z.enum(['analysis', 'marketing_plan', 'content', 'schedule']),
      refresh: z.boolean().optional(),
    }),
    rateLimit: LIMITS.analyze,
    rateLimitKey: 'pipeline',
  },
);
