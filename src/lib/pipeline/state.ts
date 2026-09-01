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
import { hasFailed, isStalled, isWaitingForWorker, stillRunning } from '../jobs/job-failure';
import type { JobType, Project, ScheduledPost, Uuid } from '../types';

export type StageName = 'analysis' | 'marketing_plan' | 'content' | 'schedule';

export type StageStatus = 'complete' | 'in_progress' | 'failed' | 'waiting' | 'not_started';

export interface Stage {
  name: StageName;
  label: string;
  status: StageStatus;
  /** What was produced. Present once the stage is complete. */
  detail: string | null;
  error: string | null;
  /**
   * Why an unfinished stage is not moving, when the reason is ordinary.
   *
   * Distinct from `error`: a stage waiting its turn in the queue has nothing
   * wrong with it, and saying so is not the same as reporting a failure.
   */
  note: string | null;
  /** True when this is the stage a retry should start from. */
  retryable: boolean;
}

/**
 * What the publisher is actually doing, counted from the rows themselves.
 *
 * Publishing happens in the background now, so the screen that started it has
 * no way to know how it went — and "the request returned 200" was never the
 * same thing as "the post is on Instagram". Every number here is a count of
 * persisted state, which is why a refresh cannot change it.
 */
export interface PublishingState {
  published: number;
  /** Queued or in flight: due, claimed, or mid-publish. */
  inFlight: number;
  /** Held for a person — a dead connection, or attempts exhausted. */
  failed: number;
  scheduled: number;
  nextSendAt: string | null;
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
  /** Live publishing state, read from the database rather than assumed. */
  publishing: PublishingState;
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
            ? 'A worker claimed this step and never reported back. ' +
              (failure?.error ? `Last error: ${failure.error}. ` : '') +
              'Press Retry — everything already saved is kept.'
            : (failure?.error ?? 'This step failed')
          : null,
      /*
       * A stage whose job is queued is waiting for the background worker, and
       * the honest thing to show is how long it has been waiting — not a
       * failure, and not a bare spinner that never explains itself.
       */
      note:
        status === 'in_progress' && progress.some((p) => isWaitingForWorker(p))
          ? `Queued, waiting for the background worker${waitedFor(progress)}.`
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

  return {
    status: coarse(stages, failedStage),
    stages,
    currentStage,
    failedStage,
    publishing: publishingState(scheduled, jobs),
  };
}

/**
 * How long the oldest waiting job has been queued, as a phrase to append.
 *
 * Empty when it is too new to be worth saying — a job queued nine seconds ago
 * is simply about to run, and putting a number on that is noise.
 */
function waitedFor(progress: { updatedAt?: string | null }[], now = Date.now()): string {
  let oldest = 0;
  for (const p of progress) {
    if (!p.updatedAt) continue;
    const at = Date.parse(p.updatedAt);
    if (!Number.isFinite(at)) continue;
    oldest = Math.max(oldest, now - at);
  }
  const minutes = Math.floor(oldest / 60_000);
  if (minutes < 1) return '';
  if (minutes < 60) return ` for ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  return ` for ${hours} hour${hours === 1 ? '' : 's'}`;
}

function publishingState(
  scheduled: ScheduledPost[],
  jobs: { type: JobType; status: string; payload: Record<string, unknown> }[],
): PublishingState {
  const claimed = new Set(
    jobs
      .filter((j) => j.type === 'publish_post' && (j.status === 'queued' || j.status === 'running'))
      .map((j) => String(j.payload.scheduledPostId ?? '')),
  );

  let published = 0;
  let failed = 0;
  let inFlight = 0;
  let waiting = 0;
  let nextSendAt: string | null = null;

  for (const post of scheduled) {
    if (post.status === 'published') {
      published++;
      continue;
    }
    if (post.status === 'failed') {
      failed++;
      continue;
    }
    // "Publishing" or a job already holding it: work genuinely under way.
    if (post.status === 'publishing' || claimed.has(post.id)) {
      inFlight++;
      continue;
    }
    waiting++;
    if (!nextSendAt || post.scheduled_for < nextSendAt) nextSendAt = post.scheduled_for;
  }

  return { published, inFlight, failed, scheduled: waiting, nextSendAt };
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
