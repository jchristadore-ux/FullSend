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
import { CONTENT_BATCH_SIZE } from '@/lib/content/generate';
import { buildStrategy } from '@/lib/strategy/build';
import { getProvider, setProvider } from '@/lib/ai/client';
import { db, enqueue, enqueueOnce, getAnalysis, getStrategy } from '@/lib/db/repo';
import { MAX_CONTENT_BATCHES, MAX_EMPTY_CONTENT_BATCHES, runJob } from '@/lib/jobs/runner';
import { pipelineState } from '@/lib/pipeline/state';
import { topUpContent } from '@/lib/automation/autopilot';
import { openSlots } from '@/lib/scheduler/schedule';
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
    await run('generate_brand');
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

  /** Runs a job with exactly this payload, rather than reusing a queued one. */
  async function runFresh(type: JobType, payload: Record<string, unknown>) {
    const job = await enqueue(ctx.scope, type, { projectId: project.id, ...payload }, {
      projectId: project.id,
    });
    return runJob({ ...job, attempts: 1 });
  }

  it('writes the calendar in batches, one durable job at a time', async () => {
    await throughPlan();

    // The brand job leaves the first content batch queued. Run it, and it must
    // leave the next batch queued rather than writing the whole calendar here.
    const first = await run('generate_content', { days: 30 });
    expect(first.status).toBe('succeeded');

    const written = await db().find(ctx.scope, 'content_items', {
      where: { project_id: project.id },
    });
    expect(written.length).toBeGreaterThan(0);
    expect(written.length).toBeLessThanOrEqual(CONTENT_BATCH_SIZE);

    const queued = await db().find(ctx.scope, 'jobs', {
      where: { project_id: project.id, type: 'generate_content', status: 'queued' },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0].payload.batch).toBe(1);

    // The next batch writes into the slots still open — it does not rewrite the
    // posts already saved, and it does not double up on their days.
    const before = written.map((i) => i.id).sort();
    await runJob({ ...(queued[0] as Job), attempts: 1 });
    const after = await db().find(ctx.scope, 'content_items', {
      where: { project_id: project.id },
    });
    for (const id of before) expect(after.map((i) => i.id)).toContain(id);
    expect(after.length).toBeGreaterThan(written.length);

    const hours = after.map((i) => i.scheduled_for);
    expect(new Set(hours).size).toBe(hours.length);
  });

  it('stops chaining batches once the window is written', async () => {
    await throughPlan();
    // Clear the 30-day batch the brand stage queued, so what remains is only
    // what this job decides to leave behind.
    for (const j of await db().find(ctx.scope, 'jobs', {
      where: { project_id: project.id, type: 'generate_content' },
    })) {
      await db().remove(ctx.scope, 'jobs', j.id);
    }

    /*
     * A one-week window is a handful of slots. The chain has to walk them a
     * batch at a time and then stop of its own accord — the failure this
     * guards against is a chain that keeps queueing itself with nothing left
     * to write, which fills the queue forever and spends the AI budget doing
     * it. So: run it out, and require both that it ends and that it ended
     * because the work ran out rather than because MAX_CONTENT_BATCHES caught
     * it.
     */
    await runFresh('generate_content', { days: 7 });

    let passes = 0;
    for (;;) {
      const queued = await db().find(ctx.scope, 'jobs', {
        where: { project_id: project.id, type: 'generate_content', status: 'queued' },
      });
      if (queued.length === 0) break;
      expect(queued).toHaveLength(1);
      expect(++passes).toBeLessThan(MAX_CONTENT_BATCHES);
      await runJob({ ...(queued[0] as Job), attempts: 1 });
    }

    // It really did write the week, rather than ending by writing nothing.
    const written = await db().find(ctx.scope, 'content_items', {
      where: { project_id: project.id },
    });
    expect(written.length).toBeGreaterThan(CONTENT_BATCH_SIZE);
  });

  /*
   * The seed, the format and the topic a batch writes against all come from
   * the slot it was given, so asking twice for the same slot gets the same
   * post back — including the same post the duplicate guard just turned down.
   * A batch that wrote nothing therefore has to move along, or the chain
   * spends its whole streak re-writing one rejected post and never reaches the
   * rest of the calendar.
   */
  it('steps past a slot it could not fill rather than asking for it again', async () => {
    await throughPlan();
    const strategy = (await getStrategy(ctx.scope, project.id))!;
    const open = await openSlots(ctx.scope, {
      project,
      strategy,
      days: 30,
      platforms: ['instagram'],
    });
    expect(open.length).toBeGreaterThan(2);

    // Two empty batches behind it: this one must land on the third slot.
    const result = await topUpContent(ctx.scope, project, 30, undefined, 'initial', 2);
    expect(result.generated).toBe(CONTENT_BATCH_SIZE);

    const written = await db().find(ctx.scope, 'content_items', {
      where: { project_id: project.id },
    });
    expect(written).toHaveLength(CONTENT_BATCH_SIZE);
    expect(written[0].scheduled_for).toBe(open[2].at.toISOString());

    // And the slots it stepped over are still counted as waiting.
    expect(result.remainingSlots).toBe(open.length - CONTENT_BATCH_SIZE);
  });

  /*
   * A batch is one post, so "this batch wrote nothing" is an ordinary event:
   * the duplicate guard turned down one hook. It must not abandon the rest of
   * the calendar — and a model that has genuinely run dry must still stop the
   * chain rather than burn the budget writing the same post forever.
   */
  describe('a batch that writes nothing', () => {
    /** Composes one fixed post, so everything after the first is a duplicate. */
    function alwaysTheSamePost(): AiProvider {
      const real = getProvider();
      return {
        name: real.name,
        live: real.live,
        modelFor: (tier) => real.modelFor(tier),
        complete: async (req: CompletionRequest) => {
          if (req.task !== 'content.batch') return real.complete(req);
          const items = Array.from({ length: CONTENT_BATCH_SIZE }, () => ({
            platform: 'instagram',
            format: 'static',
            pillar_type: 'education',
            hook: 'The one hook this model knows',
            caption: 'The one caption this model knows, said the one way it knows how to say it.',
            cta: 'Link in bio',
            hashtags: ['#tasks'],
            script: null,
            slides: null,
            video_plan: null,
          }));
          return {
            text: JSON.stringify({ items }),
            model: real.modelFor(req.tier),
            provider: real.name,
            usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
            costUsd: 0,
            cacheHit: false,
          };
        },
      };
    }

    /** Runs one content batch and returns what the handler recorded on the job. */
    async function batch(payload: Record<string, unknown>) {
      const job = await enqueue(ctx.scope, 'generate_content', {
        projectId: project.id,
        ...payload,
      }, { projectId: project.id });
      await runJob({ ...job, attempts: 1 });
      const row = (await db().get(ctx.scope, 'jobs', job.id)) as Job;
      expect(row.status).toBe('succeeded');
      return row.result as {
        generated: number;
        rejectedDuplicates: number;
        emptyStreak: number;
        nextBatchQueued: boolean;
      };
    }

    beforeEach(async () => {
      await throughPlan();
      for (const j of await db().find(ctx.scope, 'jobs', {
        where: { project_id: project.id, type: 'generate_content' },
      })) {
        await db().remove(ctx.scope, 'jobs', j.id);
      }
      setProvider(alwaysTheSamePost());
    });

    it('keeps the chain alive rather than abandoning the calendar', async () => {
      // The first batch writes the one post; the second finds it a duplicate
      // and writes nothing. The calendar still has slots, so the chain goes on.
      const first = await batch({ days: 30 });
      expect(first.generated).toBe(CONTENT_BATCH_SIZE);

      const second = await batch({ days: 30, batch: 1 });
      expect(second.generated).toBe(0);
      expect(second.rejectedDuplicates).toBeGreaterThan(0);
      expect(second.emptyStreak).toBe(1);
      expect(second.nextBatchQueued).toBe(true);
    });

    it('gives up once it has written nothing several times running', async () => {
      await batch({ days: 30 });

      // Carry the streak forward the way the chain does, up to the limit.
      let streak = 0;
      for (let i = 1; i <= MAX_EMPTY_CONTENT_BATCHES; i++) {
        const pass = await batch({ days: 30, batch: i, emptyStreak: streak });
        expect(pass.generated).toBe(0);
        streak = pass.emptyStreak;
        expect(streak).toBe(i);
        expect(pass.nextBatchQueued).toBe(i < MAX_EMPTY_CONTENT_BATCHES);
      }
    });
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

/**
 * Pressing Analyze twice.
 *
 * The button that starts the pipeline used to insert a new project on every
 * press. A new project has no repository, no analysis, no plan and no content:
 * an empty pipeline that has to run from the beginning, while everything the
 * previous press achieved sits on a project nobody is looking at any more.
 * Ten presses, ten projects, ten analyses of the same repository — and every
 * checkpoint in this file rendered meaningless, because the run being resumed
 * was never the run that had done the work.
 */
describe('starting the same repository twice', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupContext();
  });

  afterEach(() => teardown());

  /** What POST /api/projects does, exercised through its own helpers. */
  async function start(repository: string) {
    const { findProjectForRepo } = await import('@/lib/pipeline/resume');
    const existing = await findProjectForRepo(ctx.scope, ctx.user.id, repository);
    if (existing) return { project: existing, resumed: true };

    const project = await createProject(ctx.scope, ctx.user.id, {
      autopilot_mode: 'full_send',
    });
    await enqueueOnce(
      ctx.scope,
      'analyze_repository',
      { projectId: project.id, repository },
      { projectId: project.id },
    );
    return { project, resumed: false };
  }

  it('resumes the project already working on it', async () => {
    const first = await start('acme/taskflow');
    expect(first.resumed).toBe(false);

    const second = await start('acme/taskflow');
    expect(second.resumed).toBe(true);
    expect(second.project.id).toBe(first.project.id);

    const projects = await db().find(ctx.scope, 'projects', { where: { user_id: ctx.user.id } });
    expect(projects).toHaveLength(1);
  });

  it('matches once the repository row exists, not just the job', async () => {
    const first = await start('acme/taskflow');
    await analyzeProduct(ctx.scope, first.project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });

    const second = await start('acme/taskflow');
    expect(second.project.id).toBe(first.project.id);
    expect(second.resumed).toBe(true);
  });

  it('is not confused by a different repository', async () => {
    const first = await start('acme/taskflow');
    const other = await start('acme/something-else');

    expect(other.project.id).not.toBe(first.project.id);
    expect(other.resumed).toBe(false);
  });

  it('ignores case, so the same repo typed differently is the same project', async () => {
    const first = await start('acme/taskflow');
    const second = await start('ACME/TaskFlow');
    expect(second.project.id).toBe(first.project.id);
  });
});

/**
 * The plan stage, split.
 *
 * Strategy and brand profile are two model calls. Run in one job they do not
 * fit in a sixty-second invocation: the stage sat on "Working" for as long as
 * anyone watched, because the invocation was killed before either could finish
 * and there was nothing to report. And a queued job nobody has reached leaves
 * no lock to expire, so the spinner had no button under it and no way out.
 */
describe('the marketing plan', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id, { autopilot_mode: 'full_send' });
  });

  afterEach(() => teardown());

  async function run(type: JobType) {
    const { job } = await enqueueOnce(
      ctx.scope,
      type,
      { projectId: project.id },
      { projectId: project.id },
    );
    return runJob({ ...((await db().get(ctx.scope, 'jobs', job.id)) as Job), attempts: 1 });
  }

  it('runs as two jobs, and the strategy job makes only one model call', async () => {
    await analyzeProduct(ctx.scope, project, 'acme/taskflow', { client: fakeGitHubClient() });
    await run('generate_strategy');

    expect(await getStrategy(ctx.scope, project.id)).not.toBeNull();
    // The brand is the second job's work, not this one's.
    expect(await db().findOne(ctx.scope, 'brand_profiles', {
      where: { project_id: project.id },
    })).toBeNull();

    const queued = await db().find(ctx.scope, 'jobs', {
      where: { project_id: project.id, type: 'generate_brand' },
    });
    expect(queued).toHaveLength(1);
  });

  it('is complete only once both halves are saved, then starts content', async () => {
    await analyzeProduct(ctx.scope, project, 'acme/taskflow', { client: fakeGitHubClient() });
    await run('generate_strategy');

    const half = await pipelineState(ctx.scope, project);
    expect(half.stages.find((s) => s.name === 'marketing_plan')!.status).not.toBe('complete');

    await run('generate_brand');

    const whole = await pipelineState(ctx.scope, project);
    expect(whole.stages.find((s) => s.name === 'marketing_plan')!.status).toBe('complete');
    const next = await db().find(ctx.scope, 'jobs', {
      where: { project_id: project.id, type: 'generate_content' },
    });
    expect(next).toHaveLength(1);
  });

  it('does not rebuild the brand profile it already has', async () => {
    await analyzeProduct(ctx.scope, project, 'acme/taskflow', { client: fakeGitHubClient() });
    await run('generate_strategy');
    await run('generate_brand');

    const first = await db().findOne(ctx.scope, 'brand_profiles', {
      where: { project_id: project.id },
    });
    await run('generate_brand');
    const again = await db().findOne(ctx.scope, 'brand_profiles', {
      where: { project_id: project.id },
    });
    expect(again!.id).toBe(first!.id);
  });

  it('offers a button on a queued job nothing has reached', async () => {
    await analyzeProduct(ctx.scope, project, 'acme/taskflow', { client: fakeGitHubClient() });
    const { job } = await enqueueOnce(
      ctx.scope,
      'generate_strategy',
      { projectId: project.id },
      { projectId: project.id },
    );
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await db().update(ctx.scope, 'jobs', job.id, { updated_at: old });

    const state = await pipelineState(ctx.scope, project);
    const plan = state.stages.find((s) => s.name === 'marketing_plan')!;
    expect(plan.status).toBe('failed');
    expect(plan.retryable).toBe(true);
  });

  it('gives every unfinished stage a button, running or not', async () => {
    const state = await pipelineState(ctx.scope, project);
    for (const s of state.stages) {
      if (s.status !== 'complete') expect(s.retryable).toBe(true);
    }
  });
});
