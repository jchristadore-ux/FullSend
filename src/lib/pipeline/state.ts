/**
 * The pipeline, as durable checkpoints.
 *
 * FullSend is four expensive stages — understand the product, build the
 * marketing plan, write the content, schedule it — and each one's output is a
 * row in the database. That row is the checkpoint: once it exists the stage is
 * done and must never be paid for again.
 *
 * There is no separate state column to drift out of sync with reality. A stage
 * is complete because its output exists, in progress because a job for it is
 * queued or running, and failed because that job says so. State derived from
 * the work itself cannot lie about what has been done.
 */
import 'server-only';
import { type TenantScope } from '../db';
import { db, getAnalysis, getBrandProfile, getStrategy } from '../db/repo';
import { hasFailed, isStalled, stillRunning } from '../jobs/job-failure';
import type { JobType, Project, Uuid } from '../types';

export type StageName = 'analysis' | 'marketing_plan' | 'content' | 'schedule';

export type StageStatus = 'complete' | 'in_progress' | 'failed' | 'waiting' | 'not_started';

export interface Stage {
  name: StageName;
  label: string;
  status: StageStatus;
  /** What was produced. Present once the stage is complete. */
  detail: string | null;
  error: string | null;
  /** True when this is the stage a retry should start from. */
  retryable: boolean;
}

export interface PipelineState {
  /** The coarse state, for callers that want one word. */
  status:
    | 'NOT_STARTED'
    | 'ANALYSIS_IN_PROGRESS'
    | 'ANALYSIS_COMPLETE'
    | 'MARKETING_PLAN_IN_PROGRESS'
    | 'MARKETING_PLAN_COMPLETE'
    | 'CONTENT_IN_PROGRESS'
    | 'CONTENT_COMPLETE'
    | 'SCHEDULE_IN_PROGRESS'
    | 'SCHEDULE_COMPLETE'
    | 'FAILED';
  stages: Stage[];
  /** The first stage that is not complete. Null when the pipeline is done. */
  currentStage: StageName | null;
  /** The stage a retry should resume from, if anything has failed. */
  failedStage: StageName | null;
}

const LABELS: Record<StageName, string> = {
  analysis: 'Repository Analysis',
  marketing_plan: 'Marketing Plan',
  content: 'Content',
  schedule: 'Publishing Schedule',
};

/** The jobs that advance each stage. A stage is running if any of these are. */
export const STAGE_JOBS: Record<StageName, JobType[]> = {
  analysis: ['analyze_repository'],
  marketing_plan: ['generate_strategy', 'generate_brand'],
  content: ['generate_content'],
  schedule: ['schedule_content'],
};

/** The job that restarts a stage, and what it needs in its payload. */
export const STAGE_ENTRY_JOB: Record<StageName, JobType> = {
  analysis: 'analyze_repository',
  marketing_plan: 'generate_strategy',
  content: 'generate_content',
  schedule: 'schedule_content',
};

const ORDER: StageName[] = ['analysis', 'marketing_plan', 'content', 'schedule'];

export async function pipelineState(
  scope: TenantScope,
  project: Project,
): Promise<PipelineState> {
  const [analysis, strategy, brand, content, scheduled, jobs] = await Promise.all([
    getAnalysis(scope, project.id),
    getStrategy(scope, project.id),
    getBrandProfile(scope, project.id),
    db().find(scope, 'content_items', { where: { project_id: project.id }, limit: 200 }),
    db().find(scope, 'scheduled_posts', { where: { project_id: project.id }, limit: 200 }),
    db().find(scope, 'jobs', {
      where: { project_id: project.id },
      orderBy: 'created_at',
      direction: 'desc',
      limit: 40,
    }),
  ]);

  // Only the newest job of each type matters: older ones are history, and a
  // succeeded rerun must not be overruled by the failure that preceded it.
  const newest = new Map<string, (typeof jobs)[number]>();
  for (const j of jobs) if (!newest.has(j.type)) newest.set(j.type, j);

  const done: Record<StageName, boolean> = {
    analysis: Boolean(analysis),
    marketing_plan: Boolean(strategy && brand),
    content: content.length > 0,
    schedule: scheduled.length > 0,
  };

  const detail: Record<StageName, string | null> = {
    analysis: analysis ? analysis.one_liner : null,
    marketing_plan: strategy ? `v${strategy.version} — ${strategy.positioning}` : null,
    content: content.length ? `${content.length} post${content.length === 1 ? '' : 's'}` : null,
    schedule: scheduled.length
      ? `${scheduled.length} post${scheduled.length === 1 ? '' : 's'} scheduled`
      : null,
  };

  const stages: Stage[] = [];
  let failedStage: StageName | null = null;
  let currentStage: StageName | null = null;

  for (const name of ORDER) {
    const relevant = STAGE_JOBS[name].map((t) => newest.get(t)).filter(Boolean);
    const progress = relevant.map((j) => ({
      status: j!.status,
      attempts: j!.attempts,
      error: j!.last_error,
      lockedAt: j!.locked_at,
      updatedAt: j!.updated_at,
    }));

    const failure = progress.find((p) => hasFailed(p));
    const running = progress.some((p) => stillRunning(p));

    let status: StageStatus;
    if (done[name]) {
      // Complete wins over a failed job: the output is on disk either way, and
      // a stage that produced its checkpoint is not one to run again.
      status = 'complete';
    } else if (failure) {
      status = 'failed';
      failedStage ??= name;
    } else if (running) {
      status = 'in_progress';
    } else if (currentStage === null && stages.every((s) => s.status === 'complete')) {
      status = 'not_started';
    } else {
      status = 'waiting';
    }

    if (status !== 'complete' && currentStage === null) currentStage = name;

    stages.push({
      name,
      label: LABELS[name],
      status,
      detail: detail[name],
      error:
        status === 'failed'
          ? isStalled(failure)
            ? 'This step was cut off part-way and never reported back. ' +
              (failure?.error ? `Last error: ${failure.error}. ` : '') +
              'Press Retry — everything already saved is kept.'
            : (failure?.error ?? 'This step failed')
          : null,
      /*
       * Anything not finished can be started by hand. A stage showing a
       * spinner with no button was the worst state this screen could reach:
       * nothing to read, nothing to press, and no way to tell a slow step from
       * a dead one.
       */
      retryable: status !== 'complete',
    });
  }

  return { status: coarse(stages, failedStage), stages, currentStage, failedStage };
}

function coarse(stages: Stage[], failedStage: StageName | null): PipelineState['status'] {
  if (failedStage) return 'FAILED';
  const by = (n: StageName) => stages.find((s) => s.name === n)!;

  if (by('schedule').status === 'complete') return 'SCHEDULE_COMPLETE';
  if (by('schedule').status === 'in_progress') return 'SCHEDULE_IN_PROGRESS';
  if (by('content').status === 'complete') return 'CONTENT_COMPLETE';
  if (by('content').status === 'in_progress') return 'CONTENT_IN_PROGRESS';
  if (by('marketing_plan').status === 'complete') return 'MARKETING_PLAN_COMPLETE';
  if (by('marketing_plan').status === 'in_progress') return 'MARKETING_PLAN_IN_PROGRESS';
  if (by('analysis').status === 'complete') return 'ANALYSIS_COMPLETE';
  if (by('analysis').status === 'in_progress') return 'ANALYSIS_IN_PROGRESS';
  return 'NOT_STARTED';
}

/** Everything the entry job for a stage needs to run. */
export async function stagePayload(
  scope: TenantScope,
  project: Project,
  stage: StageName,
): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = { projectId: project.id };
  if (stage !== 'analysis') return base;

  const repository = await db().findOne(scope, 'repositories', {
    where: { project_id: project.id },
  });
  return repository ? { ...base, repository: `${repository.owner}/${repository.name}` } : base;
}

export type { Uuid };
