/**
 * Which project the app is looking at.
 *
 * Every page under /app resolves through `activeProject`, so a wrong answer
 * here is a founder's analysis, content, calendar and analytics all vanishing
 * at once. Those are the acceptance tests for the fallback: with no choice
 * recorded, the app lands on the project with the work in it — never on the
 * newest, empty one an "Add app" press just created.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, setupContext, teardown, type TestContext } from './helpers';
import {
  otherProjectWithWork,
  pickDefaultProject,
  resolveActiveProject,
} from '@/lib/active-project';
import { db } from '@/lib/db/repo';
import { newId, nowIso } from '@/lib/ids';
import type { Project, ProjectStatus } from '@/lib/types';

const HOUR = 3_600_000;

function at(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

describe('the default project', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupContext();
  });

  afterEach(() => teardown());

  async function project(
    name: string,
    status: ProjectStatus,
    ageMs: number,
  ): Promise<Project> {
    return createProject(ctx.scope, ctx.user.id, {
      name,
      slug: name.toLowerCase(),
      status,
      created_at: at(ageMs),
      updated_at: at(ageMs),
    });
  }

  it('prefers the project that got furthest over the newest one', async () => {
    const real = await project('Taskflow', 'live', 30 * 24 * HOUR);
    const justAdded = await project('Fresh', 'created', 0);

    const picked = await resolveActiveProject(ctx.scope, [justAdded, real], undefined);
    expect(picked?.id).toBe(real.id);
  });

  it('honours a recorded choice even when it is the emptier project', async () => {
    const real = await project('Taskflow', 'live', 30 * 24 * HOUR);
    const justAdded = await project('Fresh', 'created', 0);

    const picked = await resolveActiveProject(ctx.scope, [justAdded, real], justAdded.id);
    expect(picked?.id).toBe(justAdded.id);
  });

  it('ignores a cookie naming a project that is not in the list', async () => {
    const real = await project('Taskflow', 'content_ready', 10 * 24 * HOUR);
    const picked = await resolveActiveProject(ctx.scope, [real], newId());
    expect(picked?.id).toBe(real.id);
  });

  it('treats a paused project as established work, not as empty', async () => {
    const paused = await project('Taskflow', 'paused', 30 * 24 * HOUR);
    const justAdded = await project('Fresh', 'created', 0);

    const picked = await resolveActiveProject(ctx.scope, [justAdded, paused], undefined);
    expect(picked?.id).toBe(paused.id);
  });

  it('falls back on a stored analysis when every status says created', async () => {
    const withWork = await project('Taskflow', 'created', 20 * 24 * HOUR);
    const empty = await project('Fresh', 'created', 0);

    await db().insert(ctx.scope, 'product_analysis', {
      id: newId(),
      project_id: withWork.id,
      repository_id: null,
      one_liner: 'Ships marketing on its own',
      what_it_does: 'Reads the product and posts about it',
      category: 'developer tool',
      features: [],
      not_capabilities: [],
      tech_stack: [],
      platforms: [],
      target_market: 'founders',
      problem_solved: 'nobody markets their app',
      differentiators: [],
      maturity: 'beta',
      screens: [],
      confidence: 0.8,
      raw_signals: {},
      commit_sha: null,
      created_at: nowIso(),
    });

    const picked = await resolveActiveProject(ctx.scope, [empty, withWork], undefined);
    expect(picked?.id).toBe(withWork.id);
  });

  it('returns null only when there is genuinely nothing', async () => {
    expect(await resolveActiveProject(ctx.scope, [], undefined)).toBeNull();
    expect(pickDefaultProject([])).toBeNull();
  });

  it('breaks a tie on activity, then on age', async () => {
    const older = await project('Older', 'analyzed', 40 * 24 * HOUR);
    const newer = await project('Newer', 'analyzed', 1 * 24 * HOUR);
    // Same rank: the one worked on most recently wins.
    expect(pickDefaultProject([older, newer])?.id).toBe(newer.id);

    const touched = await db().update(ctx.scope, 'projects', older.id, {
      updated_at: nowIso(),
    });
    expect(pickDefaultProject([touched, newer])?.id).toBe(touched.id);
  });
});

describe('recovering from a cookie pinned to an empty project', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupContext();
  });

  afterEach(() => teardown());

  async function withAnalysis(project: Project): Promise<Project> {
    await db().insert(ctx.scope, 'product_analysis', {
      id: newId(),
      project_id: project.id,
      repository_id: null,
      one_liner: 'Ships marketing on its own',
      what_it_does: 'Reads the product and posts about it',
      category: 'developer tool',
      features: [],
      not_capabilities: [],
      tech_stack: [],
      platforms: [],
      target_market: 'founders',
      problem_solved: 'nobody markets their app',
      differentiators: [],
      maturity: 'beta',
      screens: [],
      confidence: 0.8,
      raw_signals: {},
      commit_sha: null,
      created_at: nowIso(),
    });
    return db().update(ctx.scope, 'projects', project.id, { status: 'live' });
  }

  it('names the project that actually holds the work', async () => {
    const real = await withAnalysis(
      await createProject(ctx.scope, ctx.user.id, {
        name: 'Taskflow',
        slug: 'taskflow',
        created_at: at(30 * 24 * HOUR),
        updated_at: at(30 * 24 * HOUR),
      }),
    );
    const empty = await createProject(ctx.scope, ctx.user.id, {
      name: 'Fresh',
      slug: 'fresh',
    });

    const session = { scope: ctx.scope, user: ctx.user } as never;
    const found = await otherProjectWithWork(session, empty.id);
    expect(found?.id).toBe(real.id);
    expect(found?.name).toBe('Taskflow');
  });

  it('stays quiet when the active project is the one with the work', async () => {
    const real = await withAnalysis(
      await createProject(ctx.scope, ctx.user.id, { name: 'Taskflow', slug: 'taskflow' }),
    );
    await createProject(ctx.scope, ctx.user.id, { name: 'Fresh', slug: 'fresh' });

    const session = { scope: ctx.scope, user: ctx.user } as never;
    expect(await otherProjectWithWork(session, real.id)).toBeNull();
  });

  it('stays quiet for a founder with a single project', async () => {
    const only = await createProject(ctx.scope, ctx.user.id);
    const session = { scope: ctx.scope, user: ctx.user } as never;
    expect(await otherProjectWithWork(session, only.id)).toBeNull();
  });
});
