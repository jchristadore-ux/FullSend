/**
 * The pipeline as durable checkpoints.
 *
 * Four expensive stages, each of which saves its output. Once that output
 * exists the stage is finished and must never be paid for again — not on a
 * restart, not on a refresh, and above all not because a later stage failed.
 * These are the acceptance tests for that behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, fakeGitHubClient, setupContext, teardown, type TestContext } from './helpers';
import { analyzeProduct } from '@/lib/analysis/analyze';
import { buildStrategy } from '@/lib/strategy/build';
import { getProvider, setProvider } from '@/lib/ai/client';
import { db, enqueueOnce, getAnalysis, getStrategy } from '@/lib/db/repo';
import { runJob } from '@/lib/jobs/runner';
import { pipelineState } from '@/lib/pipeline/state';
import type { AiProvider, CompletionRequest } from '@/lib/ai/types';
import type { Job, JobType, Project } from '@/lib/types';

function providerFailingOn(task: string): AiProvider {
  const real = getProvider();
  return {
    name: real.name,
    live: real.live,
    modelFor: (tier) => real.modelFor(tier),
    complete: async (req: CompletionRequest) => {
      if (req.task === task) throw new Error('provider exploded');
      return real.complete(req);
    },
  };
}

describe('durable, resumable pipeline', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id, { autopilot_mode: 'full_send' });
  });

  afterEach(() => teardown());

  /** Runs one job of `type` to completion and reports its outcome. */
  async function run(type: JobType, payload: Record<string, unknown> = {}) {
    const { job } = await enqueueOnce(
      ctx.scope,
      type,
      { projectId: project.id, ...payload },
      { projectId: project.id },
    );
    const row = (await db().get(ctx.scope, 'jobs', job.id)) as Job;
    return runJob({ ...row, attempts: 1 });
  }

  async function stage(name: string) {
    const state = await pipelineState(ctx.scope, project);
    return state.stages.find((s) => s.name === name)!;
  }

  /** Everything up to and including the marketing plan, the way the queue does. */
  async function throughPlan() {
    const product = await analyzeProduct(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });
    await run('generate_strategy');
    return product.analysis;
  }

  it('Test 1 — a new project runs every stage and saves each one', async () => {
    expect((await pipelineState(ctx.scope, project)).status).toBe('NOT_STARTED');

    await throughPlan();
    expect((await stage('analysis')).status).toBe('complete');
    expect((await stage('marketing_plan')).status).toBe('complete');

    await run('generate_content');
    expect((await stage('content')).status).toBe('complete');

    await run('schedule_content');
    const state = await pipelineState(ctx.scope, project);
    expect(state.stages.map((s) => s.status)).toEqual([
      'complete',
      'complete',
      'complete',
      'complete',
    ]);
    expect(state.status).toBe('SCHEDULE_COMPLETE');
    expect(state.currentStage).toBeNull();
  });

  it('Test 2 — analysis is not run again once it is saved', async () => {
    const first = await analyzeProduct(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });

    const again = await analyzeProduct(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });

    expect(again.analysis.id).toBe(first.analysis.id);
    expect(again.ran).toEqual({ ingest: false, analysis: false });
    expect(again.costUsd).toBe(0);
  });

  it('Test 3 — neither analysis nor the marketing plan is rebuilt on a re-run', async () => {
    const analysis = await throughPlan();
    const saved = await getStrategy(ctx.scope, project.id);

    const personas = await db().find(ctx.scope, 'personas', { where: { project_id: project.id } });
    const again = await buildStrategy(ctx.scope, project, analysis, personas);

    expect(again.strategy.id).toBe(saved!.id);
    expect(again.strategy.version).toBe(saved!.version);
    expect(again.costUsd).toBe(0);

    // And exactly one plan exists — a re-run must not stack versions.
    const all = await db().find(ctx.scope, 'marketing_strategies', {
      where: { project_id: project.id },
    });
    expect(all).toHaveLength(1);
  });

  it('Test 4 — a content failure keeps every earlier stage and resumes mid-batch', async () => {
    await throughPlan();
    const analysisId = (await getAnalysis(ctx.scope, project.id))!.id;
    const strategyId = (await getStrategy(ctx.scope, project.id))!.id;

    setProvider(providerFailingOn('content.batch'));
    await run('generate_content');

    // Nothing before content was touched.
    expect((await getAnalysis(ctx.scope, project.id))!.id).toBe(analysisId);
    expect((await getStrategy(ctx.scope, project.id))!.id).toBe(strategyId);
    expect((await stage('analysis')).status).toBe('complete');
    expect((await stage('marketing_plan')).status).toBe('complete');

    setProvider(null);
    await run('generate_content');
    const items = await db().find(ctx.scope, 'content_items', {
      where: { project_id: project.id },
    });
    expect(items.length).toBeGreaterThan(0);

    // A second pass writes into the slots still open rather than rewriting the
    // posts already saved.
    const ids = items.map((i) => i.id).sort();
    await run('generate_content');
    const after = await db().find(ctx.scope, 'content_items', {
      where: { project_id: project.id },
    });
    for (const id of ids) expect(after.map((i) => i.id)).toContain(id);
  });

  it('Test 5 — with content saved, only the schedule stage runs', async () => {
    await throughPlan();
    await run('generate_content');

    const items = await db().find(ctx.scope, 'content_items', {
      where: { project_id: project.id },
    });
    const analysisId = (await getAnalysis(ctx.scope, project.id))!.id;
    const strategyId = (await getStrategy(ctx.scope, project.id))!.id;

    const state = await pipelineState(ctx.scope, project);
    expect(state.currentStage).toBe('schedule');

    await run('schedule_content');

    expect((await getAnalysis(ctx.scope, project.id))!.id).toBe(analysisId);
    expect((await getStrategy(ctx.scope, project.id))!.id).toBe(strategyId);
    const afterItems = await db().find(ctx.scope, 'content_items', {
      where: { project_id: project.id },
    });
    expect(afterItems).toHaveLength(items.length);
    expect((await stage('schedule')).status).toBe('complete');
  });

  it('Test 6 — a schedule failure leaves everything before it untouched', async () => {
    await throughPlan();
    await run('generate_content');

    const before = await pipelineState(ctx.scope, project);
    const contentCount = (
      await db().find(ctx.scope, 'content_items', { where: { project_id: project.id } })
    ).length;

    // Nothing is approved, so scheduling has nothing to place: the stage does
    // not complete, and must not disturb what came before it.
    await db().find(ctx.scope, 'content_items', { where: { project_id: project.id } });
    await run('schedule_content');

    const after = await pipelineState(ctx.scope, project);
    expect(after.stages[0].status).toBe(before.stages[0].status);
    expect(after.stages[1].status).toBe(before.stages[1].status);
    expect(
      (await db().find(ctx.scope, 'content_items', { where: { project_id: project.id } })).length,
    ).toBe(contentCount);
  });

  it('Test 7 — simultaneous requests do not duplicate a stage', async () => {
    const results = await Promise.all([
      enqueueOnce(ctx.scope, 'analyze_repository', { projectId: project.id }, { projectId: project.id }),
      enqueueOnce(ctx.scope, 'analyze_repository', { projectId: project.id }, { projectId: project.id }),
      enqueueOnce(ctx.scope, 'analyze_repository', { projectId: project.id }, { projectId: project.id }),
    ]);

    const ids = new Set(results.map((r) => r.job.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);

    const jobs = await db().find(ctx.scope, 'jobs', {
      where: { project_id: project.id, type: 'analyze_repository' },
    });
    expect(jobs).toHaveLength(1);
  });

  it('does not read a failed attempt as a completed stage', async () => {
    setProvider(providerFailingOn('analysis.product'));
    await run('analyze_repository', { repository: 'acme/taskflow' });

    const analysis = await stage('analysis');
    expect(analysis.status).not.toBe('complete');
    expect(analysis.retryable).toBe(true);
    expect((await pipelineState(ctx.scope, project)).failedStage).toBe('analysis');
  });

  it('reports a completed stage as complete even after an earlier failure', async () => {
    setProvider(providerFailingOn('analysis.product'));
    await run('analyze_repository', { repository: 'acme/taskflow' });
    expect((await stage('analysis')).status).toBe('failed');

    setProvider(null);
    await analyzeProduct(ctx.scope, project, 'acme/taskflow', { client: fakeGitHubClient() });

    // The output is on disk. A stale failed row must not outrank it.
    expect((await stage('analysis')).status).toBe('complete');
    expect((await pipelineState(ctx.scope, project)).failedStage).toBeNull();
  });
});

/**
 * The deadlock that made Retry do nothing.
 *
 * A serverless invocation killed at sixty seconds leaves `status: 'running'`
 * and a claim nobody releases. Everything downstream read that as work in
 * progress: the pipeline showed a spinner with no button under it, and
 * `enqueueOnce` refused to start the stage again because a copy was supposedly
 * already in flight. Nothing was running. Nothing could be started.
 */
describe('a job whose worker died', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id, { autopilot_mode: 'full_send' });
  });

  afterEach(() => teardown());

  /** A job claimed long enough ago that its worker cannot still be alive. */
  async function stalledJob(type: JobType) {
    const { job } = await enqueueOnce(
      ctx.scope,
      type,
      { projectId: project.id },
      { projectId: project.id },
    );
    return db().update(ctx.scope, 'jobs', job.id, {
      status: 'running',
      locked_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
  }

  it('is offered as a retry rather than an endless spinner', async () => {
    await stalledJob('analyze_repository');

    const state = await pipelineState(ctx.scope, project);
    const analysis = state.stages.find((s) => s.name === 'analysis')!;

    expect(analysis.status).toBe('failed');
    expect(analysis.retryable).toBe(true);
    expect(analysis.error).toMatch(/cut off part-way/);
    expect(state.failedStage).toBe('analysis');
  });

  it('does not block the stage from being started again', async () => {
    const dead = await stalledJob('analyze_repository');

    const { job, created } = await enqueueOnce(
      ctx.scope,
      'analyze_repository',
      { projectId: project.id },
      { projectId: project.id },
    );

    expect(created).toBe(true);
    expect(job.id).not.toBe(dead.id);
  });

  it('still refuses to duplicate a job that is genuinely running', async () => {
    const { job: first } = await enqueueOnce(
      ctx.scope,
      'analyze_repository',
      { projectId: project.id },
      { projectId: project.id },
    );
    await db().update(ctx.scope, 'jobs', first.id, {
      status: 'running',
      locked_at: new Date().toISOString(),
    });

    const { job, created } = await enqueueOnce(
      ctx.scope,
      'analyze_repository',
      { projectId: project.id },
      { projectId: project.id },
    );

    expect(created).toBe(false);
    expect(job.id).toBe(first.id);

    const state = await pipelineState(ctx.scope, project);
    expect(state.stages.find((s) => s.name === 'analysis')!.status).toBe('in_progress');
  });

  it('leaves a completed stage complete even with a dead claim against it', async () => {
    await analyzeProduct(ctx.scope, project, 'acme/taskflow', { client: fakeGitHubClient() });
    await stalledJob('analyze_repository');

    const state = await pipelineState(ctx.scope, project);
    expect(state.stages.find((s) => s.name === 'analysis')!.status).toBe('complete');
  });
});
