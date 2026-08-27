/**
 * Why the calendar is empty.
 *
 * Generation declines to run for five separate reasons, and each has a
 * different fix. Checked only inside the job, every one of them looked
 * identical from the outside: press "Generate 30 days", get nothing, press it
 * again. What made that unfalsifiable was the messaging — a no-op reported as
 * progress, and a remedy ("try a longer window") appended to reasons a longer
 * window cannot fix.
 *
 * So: the blocker must be readable before the button is pressed, it must name
 * its own fix, a failed run must not read as a running one, and the longer
 * window must only be suggested where a longer window is genuinely the answer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, fakeGitHubClient, setupContext, teardown, type TestContext } from './helpers';
import { analyzeRepository } from '@/lib/analysis/analyze';
import { approveStrategy, buildStrategy } from '@/lib/strategy/build';
import { generationBlocker, topUpContent } from '@/lib/automation/autopilot';
import { longerWindowHelps } from '@/lib/content/blockers';
import { describeGenerationOutcome } from '@/lib/jobs/generation-outcome';
import { db, enqueue, recordError } from '@/lib/db/repo';
import { systemScope } from '@/lib/db';
import { runJob } from '@/lib/jobs/runner';
import { loadSendCenter } from '@/lib/dashboard';
import { nowIso } from '@/lib/ids';
import type { Project } from '@/lib/types';

describe('generation blockers', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
  });
  afterEach(() => teardown());

  it('names the missing analysis on a brand-new project', async () => {
    const blocked = await generationBlocker(ctx.scope, project);
    expect(blocked?.code).toBe('no_analysis');
    expect(blocked?.fix.href).toBe('/onboarding');
  });

  it('names the missing strategy once the repo is analysed', async () => {
    await analyzeRepository(ctx.scope, project, 'acme/taskflow', { client: fakeGitHubClient() });

    const blocked = await generationBlocker(ctx.scope, project);
    expect(blocked?.code).toBe('no_strategy');
  });

  it('points at the approval when the strategy is written but not approved', async () => {
    const analyzed = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });
    await buildStrategy(ctx.scope, project, analyzed.analysis, analyzed.personas);

    const blocked = await generationBlocker(ctx.scope, project);
    expect(blocked?.code).toBe('strategy_unapproved');
    // The fix is a link to the page with the approve button, not a suggestion
    // to press generate again.
    expect(blocked?.fix.href).toBe('/app/strategy');
    expect(blocked?.message).toContain('not approved');
  });

  it('clears once the strategy is approved', async () => {
    const analyzed = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });
    const built = await buildStrategy(ctx.scope, project, analyzed.analysis, analyzed.personas);
    await approveStrategy(ctx.scope, built.strategy.id);

    expect(await generationBlocker(ctx.scope, project)).toBeNull();
  });

  it('hands the same blocker back from a generation run, so the two agree', async () => {
    const analyzed = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });
    await buildStrategy(ctx.scope, project, analyzed.analysis, analyzed.personas);

    const result = await topUpContent(ctx.scope, project, 30);
    expect(result.generated).toBe(0);
    expect(result.blocker?.code).toBe('strategy_unapproved');
    expect(result.reason).toBe(result.blocker?.message);
  });
});

describe('what the generate button says', () => {
  const done = (reason: string) => ({ status: 'succeeded', result: { generated: 0, reason } });

  it('does not suggest a longer window for a blocker a longer window cannot fix', () => {
    const message = describeGenerationOutcome(
      done('Your strategy is written but not approved.'),
      30,
    );
    expect(message).not.toContain('longer window');
    expect(message).toContain('not approved');
  });

  it('still suggests a longer window when the calendar is simply full', () => {
    const message = describeGenerationOutcome(done('The calendar is already full for this window'), 30);
    expect(message).toContain('Try a longer window.');
  });

  it('still suggests a longer window when everything repeated earlier posts', () => {
    const message = describeGenerationOutcome(
      done('Nothing new passed the duplicate check'),
      30,
    );
    expect(message).toContain('Try a longer window.');
  });

  it('treats an unknown reason as one a longer window might fix', () => {
    // Better to over-offer the cheap remedy than to swallow an unfamiliar one.
    expect(longerWindowHelps(undefined)).toBe(true);
  });

  /*
   * The runner requeues a retryable failure rather than marking it failed, so
   * a status check sees 'queued' with the reason sitting in last_error. Every
   * retry then reads back as progress and the founder is told to refresh, for
   * as long as the failure keeps happening.
   */
  it('reports a requeued failure instead of calling it progress', () => {
    const message = describeGenerationOutcome(
      {
        status: 'queued',
        attempts: 1,
        error: 'Your credit balance is too low to access the Anthropic API.',
      },
      30,
    );
    expect(message).not.toContain('refresh in a moment');
    expect(message).toContain('credit balance');
  });

  it('still reads as progress before the first attempt', () => {
    const message = describeGenerationOutcome({ status: 'queued', attempts: 0, error: null }, 30);
    expect(message).toContain('Still working');
  });

  it('reports a job that exhausted its retries', () => {
    expect(
      describeGenerationOutcome({ status: 'dead', attempts: 5, error: 'Repo not found' }, 30),
    ).toBe('Repo not found');
  });

  it('reports what a successful run actually wrote', () => {
    expect(
      describeGenerationOutcome({ status: 'succeeded', result: { generated: 18, blockedByQc: 6 } }, 30),
    ).toBe('Wrote 18 posts. 6 held for your review.');
  });
});

/**
 * A failure that is still retrying has to be visible while it retries.
 *
 * The error used to be recorded only when a job exhausted its attempts. Until
 * then the row read `queued`, the Send Center listed fatal errors only, and
 * nothing anywhere accounted for the failure — through five attempts and, at
 * the queue's real cadence, several hours. That is precisely the window in
 * which a founder is pressing the button and getting nothing.
 */
describe('a retrying job is not silent', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
  });
  afterEach(() => teardown());

  it('records the error on the first failure, not only on the last', async () => {
    const sys = systemScope('test');
    // A job whose project does not exist fails deterministically, and has
    // attempts left, so it is requeued rather than killed.
    await enqueue(sys, 'daily_autopilot', { projectId: 'does-not-exist' }, {
      projectId: project.id,
      maxAttempts: 5,
    });

    const claimed = await db().claimNextJob(nowIso(), 60_000);
    expect((await runJob(claimed!)).status).toBe('failed');

    const errors = await db().find(sys, 'automation_errors', {
      where: { project_id: project.id },
    });
    expect(errors).toHaveLength(1);
    // Not fatal: it has attempts left and is genuinely still retrying.
    expect(errors[0].fatal).toBe(false);
    expect(errors[0].message).toBeTruthy();
  });

  it('shows that error on the Send Center while it is still retrying', async () => {
    const sys = systemScope('test');
    await recordError(sys, {
      projectId: project.id,
      scope: 'job:generate_content',
      message: 'Your credit balance is too low to access the Anthropic API.',
      remedy: null,
      fatal: false,
    });

    const data = await loadSendCenter(ctx.scope, project);
    expect(data.attention).toHaveLength(1);
    expect(data.attention[0].message).toContain('credit balance');
    expect(data.attention[0].remedy).toContain('retrying');
  });

  it('collapses the same failure repeated across attempts into one item', async () => {
    const sys = systemScope('test');
    const message = 'Your credit balance is too low to access the Anthropic API.';
    for (let i = 0; i < 3; i++) {
      await recordError(sys, {
        projectId: project.id,
        scope: 'job:generate_content',
        message,
        remedy: null,
        fatal: false,
      });
    }

    const data = await loadSendCenter(ctx.scope, project);
    // Three attempts at one problem is one problem.
    expect(data.attention).toHaveLength(1);
  });
});
