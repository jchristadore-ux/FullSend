/**
 * A website project created while migration 0007 was pending.
 *
 * The Supabase driver drops a column the database does not have yet rather
 * than failing the write, so such a project was stored with no `source_type`
 * and no `website_url`. It reads as a GitHub project, has no repository, and
 * every route that trusted the row alone dead-ended on "no repository" — on a
 * project the founder created by pasting a URL. These are the tests for
 * recovering it from its own history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, setupContext, teardown, type TestContext } from './helpers';
import { db, enqueue } from '@/lib/db/repo';
import { healProjectSource, resolveProjectSource } from '@/lib/pipeline/source';
import { newId, nowIso } from '@/lib/ids';
import type { Project } from '@/lib/types';

describe('a project whose source could not be stored', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    // Exactly what the driver leaves behind: the website columns never landed.
    project = await createProject(ctx.scope, ctx.user.id, {
      name: 'Stripe',
      slug: 'stripe',
      status: 'failed',
      source_type: 'github',
      website_url: null,
    });
    await enqueue(ctx.scope, 'analyze_repository', {
      projectId: project.id,
      websiteUrl: 'https://stripe.com',
    }, { projectId: project.id });
  });

  afterEach(() => teardown());

  it('recovers the website from the analysis job that was queued for it', async () => {
    const source = await resolveProjectSource(ctx.scope, project);
    expect(source).toEqual({ kind: 'website', url: 'https://stripe.com' });
  });

  it('writes the source back to the project once the schema can hold it', async () => {
    const { project: healed, source } = await healProjectSource(ctx.scope, project);
    expect(source.kind).toBe('website');
    expect(healed.source_type).toBe('website');
    expect(healed.website_url).toBe('https://stripe.com');

    const stored = await db().get(ctx.scope, 'projects', project.id);
    expect(stored?.website_url).toBe('https://stripe.com');
  });

  it('leaves a healthy website project alone', async () => {
    const site = await createProject(ctx.scope, ctx.user.id, {
      name: 'Linear',
      slug: 'linear',
      source_type: 'website',
      website_url: 'https://linear.app',
    });
    const { project: healed, source } = await healProjectSource(ctx.scope, site);
    expect(source).toEqual({ kind: 'website', url: 'https://linear.app' });
    expect(healed.updated_at).toBe(site.updated_at);
  });

  it('still prefers a real repository row over job history', async () => {
    const repo = await createProject(ctx.scope, ctx.user.id, { name: 'Taskflow', slug: 'tf' });
    await db().insert(ctx.scope, 'repositories', {
      id: newId(),
      project_id: repo.id,
      provider: 'github',
      owner: 'acme',
      name: 'taskflow',
      url: 'https://github.com/acme/taskflow',
      default_branch: 'main',
      description: null,
      primary_language: null,
      languages: {},
      topics: [],
      stars: 0,
      is_private: false,
      last_indexed_at: null,
      commit_sha: null,
      created_at: nowIso(),
    });
    const source = await resolveProjectSource(ctx.scope, repo);
    expect(source).toEqual({ kind: 'github', repository: 'acme/taskflow' });
  });

  it('reports no source when there is genuinely none', async () => {
    const bare = await createProject(ctx.scope, ctx.user.id, { name: 'Bare', slug: 'bare' });
    expect(await resolveProjectSource(ctx.scope, bare)).toEqual({ kind: 'none' });
  });
});
