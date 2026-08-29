import { NextResponse } from 'next/server';
import { route, LIMITS } from '@/lib/api/handler';
import { createProjectInput } from '@/lib/schemas';
import { db, enqueueOnce, getRepository, listProjects } from '@/lib/db/repo';
import { newId, nowIso, slugify } from '@/lib/ids';
import { parseRepoInput } from '@/lib/github/client';
import { FullSendError } from '@/lib/errors';
import { planLimitsFor, subscriptionFor } from '@/lib/billing/plans';
import {
  pipelineState,
  stagePayload,
  STAGE_ENTRY_JOB,
  type StageName,
} from '@/lib/pipeline/state';
import type { TenantScope } from '@/lib/db';
import { findProjectForRepo } from '@/lib/pipeline/resume';
import type { Project } from '@/lib/types';

export const runtime = 'nodejs';

export const GET = route(async ({ session }) => {
  const projects = await listProjects(session.scope, session.user.id);
  return { projects };
});

/**
 * Starts — or resumes — the chain for a repository.
 *
 * This used to insert a new project every time it was called, and the button
 * that calls it is the one labelled "Analyze it". So every press produced a
 * fresh project with no repository, no analysis, no plan and no content: an
 * empty pipeline that had to run from the beginning, while the work already
 * done sat on the project pressed before it. Ten presses, ten projects, ten
 * analyses of the same repository, and a founder correctly reporting that
 * FullSend starts over every single time.
 *
 * The durable checkpoints only mean anything if the same project is the one
 * being resumed. So a repository FullSend is already working on returns that
 * project, and the stage that has not finished is queued — once, because
 * `enqueueOnce` will not stack a second copy of work already in flight.
 */
export const POST = route(
  async ({ session, body }) => {
    const ref = parseRepoInput(body.repository);

    const already = await findProjectForRepo(session.scope, session.user.id, body.repository);
    if (already) {
      const { stage, payload } = await resumePoint(session.scope, already);
      if (stage) {
        await enqueueOnce(session.scope, STAGE_ENTRY_JOB[stage], payload, {
          projectId: already.id,
        });
      }
      return NextResponse.json(
        { project: already, resumed: true, stage: stage ?? 'complete' },
        { status: 200 },
      );
    }

    const subscription = await subscriptionFor(session.scope, session.user.id);
    const limits = planLimitsFor(subscription.tier);
    const existing = await listProjects(session.scope, session.user.id);
    if (existing.length >= limits.projects) {
      throw new FullSendError(
        'plan_limit',
        `Your plan includes ${limits.projects} project${limits.projects === 1 ? '' : 's'}`,
        {
          status: 402,
          remedy: 'Upgrade to add more projects, or delete an existing one.',
        },
      );
    }

    const name = body.name?.trim() || titleize(ref.name);
    const project = await db().insert(session.scope, 'projects', {
      id: newId(),
      user_id: session.user.id,
      name,
      slug: uniqueSlug(name, existing.map((p) => p.slug)),
      status: 'created',
      autopilot_mode: body.autopilot_mode,
      timezone: body.timezone,
      is_internal: false,
      last_autopilot_run_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    // Sensible defaults so the project is usable before anyone opens settings.
    await db().insert(session.scope, 'settings', {
      id: newId(),
      project_id: project.id,
      auto_publish_pillars: ['education', 'product_demo', 'entertainment', 'social_proof'],
      require_approval_for_promotion: true,
      daily_post_cap: 3,
      quiet_hours: { start: 22, end: 7 },
      notify_email: true,
      trend_participation: true,
      updated_at: nowIso(),
    });

    const { job } = await enqueueOnce(
      session.scope,
      'analyze_repository',
      { projectId: project.id, repository: `${ref.owner}/${ref.name}` },
      { projectId: project.id },
    );

    return NextResponse.json({ project, jobId: job.id, resumed: false }, { status: 201 });
  },
  {
    schema: createProjectInput,
    rateLimit: LIMITS.analyze,
    rateLimitKey: 'create-project',
  },
);

/** The first stage that has not produced its output, and what it needs. */
async function resumePoint(
  scope: TenantScope,
  project: Project,
): Promise<{ stage: StageName | null; payload: Record<string, unknown> }> {
  const state = await pipelineState(scope, project);
  const stage = state.currentStage;
  if (!stage) return { stage: null, payload: {} };
  return { stage, payload: await stagePayload(scope, project, stage) };
}

function titleize(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function uniqueSlug(name: string, taken: string[]): string {
  const base = slugify(name);
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
