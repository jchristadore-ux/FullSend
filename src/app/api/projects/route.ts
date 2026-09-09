import { NextResponse } from 'next/server';
import { route, LIMITS } from '@/lib/api/handler';
import { createProjectInput } from '@/lib/schemas';
import { db, enqueueOnce, listProjects } from '@/lib/db/repo';
import { newId, nowIso, slugify } from '@/lib/ids';
import { parseRepoInput } from '@/lib/github/client';
import { assertCanCreateProject } from '@/lib/billing/enforce';
import {
  pipelineState,
  stagePayload,
  STAGE_ENTRY_JOB,
  type StageName,
} from '@/lib/pipeline/state';
import type { TenantScope } from '@/lib/db';
import { findProjectForRepo, findProjectForWebsite } from '@/lib/pipeline/resume';
import { canonicalWebsiteUrl, nameFromWebsiteUrl } from '@/lib/website/url';
import type { Project } from '@/lib/types';

export const runtime = 'nodejs';

export const GET = route(async ({ session }) => {
  const projects = await listProjects(session.scope, session.user.id);
  return { projects };
});

/**
 * Starts — or resumes — the chain for a repository or a website.
 *
 * The durable checkpoints only mean anything if the same project is the one
 * being resumed. So a source FullSend is already working on returns that
 * project, and the stage that has not finished is queued — once, because
 * `enqueueOnce` will not stack a second copy of work already in flight.
 */
export const POST = route(
  async ({ session, body }) => {
    const websiteRaw = body.website_url?.trim();
    const repoRaw = body.repository?.trim();

    if (websiteRaw) {
      const websiteUrl = canonicalWebsiteUrl(websiteRaw);

      const already = await findProjectForWebsite(session.scope, session.user.id, websiteUrl);
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

      await assertCanCreateProject(session.scope, session.user.id);

      const existing = await listProjects(session.scope, session.user.id);
      const name = body.name?.trim() || nameFromWebsiteUrl(websiteUrl);
      const project = await db().insert(session.scope, 'projects', {
        id: newId(),
        user_id: session.user.id,
        name,
        slug: uniqueSlug(name, existing.map((p) => p.slug)),
        status: 'created',
        autopilot_mode: body.autopilot_mode,
        timezone: body.timezone,
        source_type: 'website',
        website_url: websiteUrl,
        is_internal: false,
        last_autopilot_run_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      });

      await insertDefaultSettings(session.scope, project.id);

      const { job } = await enqueueOnce(
        session.scope,
        'analyze_repository',
        { projectId: project.id, websiteUrl },
        { projectId: project.id },
      );

      return NextResponse.json({ project, jobId: job.id, resumed: false }, { status: 201 });
    }

    // GitHub path (unchanged behaviour).
    const ref = parseRepoInput(repoRaw!);

    const already = await findProjectForRepo(session.scope, session.user.id, body.repository!);
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

    await assertCanCreateProject(session.scope, session.user.id);

    const existing = await listProjects(session.scope, session.user.id);
    const name = body.name?.trim() || titleize(ref.name);
    const project = await db().insert(session.scope, 'projects', {
      id: newId(),
      user_id: session.user.id,
      name,
      slug: uniqueSlug(name, existing.map((p) => p.slug)),
      status: 'created',
      autopilot_mode: body.autopilot_mode,
      timezone: body.timezone,
      source_type: 'github',
      website_url: null,
      is_internal: false,
      last_autopilot_run_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    await insertDefaultSettings(session.scope, project.id);

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

async function insertDefaultSettings(scope: TenantScope, projectId: string) {
  await db().insert(scope, 'settings', {
    id: newId(),
    project_id: projectId,
    auto_publish_pillars: ['education', 'product_demo', 'entertainment', 'social_proof'],
    require_approval_for_promotion: true,
    daily_post_cap: 3,
    quiet_hours: { start: 22, end: 7 },
    notify_email: true,
    trend_participation: true,
    updated_at: nowIso(),
  });
}

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
