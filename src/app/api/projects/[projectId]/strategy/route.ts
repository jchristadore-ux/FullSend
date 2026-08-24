import { projectRoute } from '@/lib/api/handler';
import { approveStrategyInput } from '@/lib/schemas';
import {
  audit,
  db,
  enqueue,
  getBrandProfile,
  getStrategy,
  listCampaigns,
  listPersonas,
  listPillars,
} from '@/lib/db/repo';
import { approveStrategy } from '@/lib/strategy/build';
import { FullSendError } from '@/lib/errors';

export const runtime = 'nodejs';

export const GET = projectRoute(async ({ session, project }) => {
  const [strategy, pillars, campaigns, brand, personas] = await Promise.all([
    getStrategy(session.scope, project.id),
    listPillars(session.scope, project.id),
    listCampaigns(session.scope, project.id),
    getBrandProfile(session.scope, project.id),
    listPersonas(session.scope, project.id),
  ]);
  return { strategy, pillars, campaigns, brand, personas };
});

/**
 * Approving is the gate that unlocks the machine: it queues the first content
 * batch, which then schedules itself.
 */
export const POST = projectRoute(
  async ({ session, project, body }) => {
    const strategy = await getStrategy(session.scope, project.id);
    if (!strategy) {
      throw new FullSendError('not_found', 'No strategy to approve yet', {
        status: 404,
        remedy: 'Wait for the analysis to finish, or re-run it.',
      });
    }

    const approved = await approveStrategy(session.scope, strategy.id, body);

    await audit(session.scope, {
      user_id: session.user.id,
      project_id: project.id,
      action: 'strategy.approved',
      target: strategy.id,
      metadata: { edited: Object.keys(body ?? {}) },
      ip: null,
    });

    const job = await enqueue(
      session.scope,
      'generate_content',
      { projectId: project.id, days: 30, origin: 'initial' },
      { projectId: project.id },
    );

    return { strategy: approved, jobId: job.id };
  },
  { schema: approveStrategyInput },
);

/** Rebuilds the strategy from scratch. */
export const PUT = projectRoute(async ({ session, project }) => {
  const job = await enqueue(
    session.scope,
    'generate_strategy',
    { projectId: project.id },
    { projectId: project.id },
  );
  void db;
  return { jobId: job.id, status: 'queued' };
});
