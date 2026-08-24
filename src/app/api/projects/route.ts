import { NextResponse } from 'next/server';
import { route, LIMITS } from '@/lib/api/handler';
import { createProjectInput } from '@/lib/schemas';
import { db, enqueue, listProjects } from '@/lib/db/repo';
import { newId, nowIso, slugify } from '@/lib/ids';
import { parseRepoInput } from '@/lib/github/client';
import { FullSendError } from '@/lib/errors';
import { planLimitsFor, subscriptionFor } from '@/lib/billing/plans';

export const runtime = 'nodejs';

export const GET = route(async ({ session }) => {
  const projects = await listProjects(session.scope, session.user.id);
  return { projects };
});

/**
 * Creating a project kicks off the whole chain: analysis is queued immediately
 * and strategy follows it automatically, so the founder waits once.
 */
export const POST = route(
  async ({ session, body }) => {
    const ref = parseRepoInput(body.repository);

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

    const job = await enqueue(
      session.scope,
      'analyze_repository',
      { projectId: project.id, repository: `${ref.owner}/${ref.name}` },
      { projectId: project.id },
    );

    return NextResponse.json({ project, jobId: job.id }, { status: 201 });
  },
  {
    schema: createProjectInput,
    rateLimit: LIMITS.analyze,
    rateLimitKey: 'create-project',
  },
);

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
