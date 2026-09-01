/**
 * AUTOPILOT — the daily loop.
 *
 * This is the defining feature: the founder turns it on once and the machine
 * keeps running. Every step is recorded on the automation run, so the founder
 * can always see exactly what FullSend did on their behalf and why.
 *
 * The loop, once per day per project:
 *   1. Check social connections
 *   2. Check upcoming posts
 *   3. Generate missing content
 *   4. Run quality control
 *   5. Publish scheduled content
 *   6. Collect analytics
 *   7. Evaluate performance
 *   8. Identify opportunities
 *   9. Generate additional content
 *  10. Schedule future content
 *  11. Optimize the content mix
 */
import 'server-only';
import { systemScope, type TenantScope } from '../db';
import {
  db,
  dueScheduledPosts,
  enqueueOnce,
  getAnalysis,
  getBrandProfile,
  getSettings,
  getStrategy,
  listCampaigns,
  listPersonas,
  listPillars,
  notify,
  recordError,
} from '../db/repo';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import { checkAllConnections, getUsableConnection } from '../social/connections';
import { LIVE_PLATFORMS } from '../types';
import { generateContent } from '../content/generate';
import { blocker, type GenerationBlocker } from '../content/blockers';
import { runQualityControl, canAutoPublish } from '../qc/check';
import { openSlots, queueDepth, scheduleContent } from '../scheduler/schedule';
import { resumeAfterReconnect } from '../publish/publish';
import { collectAnalytics } from '../analytics/collect';
import { optimize } from '../optimizer/optimize';
import { scanTrends } from '../trends/scan';
import type { AutomationRun, AutomationStep, ContentItem, Platform, Project, ScheduledPost } from '../types';

const log = logger('autopilot');

/** Keep at least this much scheduled content ahead at all times. */
const MIN_RUNWAY_DAYS = 10;
const TOPUP_WINDOW_DAYS = 14;

export interface AutopilotResult {
  run: AutomationRun;
  /**
   * Posts handed to the publisher as durable jobs. The loop no longer waits on
   * Instagram itself, so this counts what it queued — not what went live,
   * which is the publisher's own record to keep.
   */
  queuedToPublish: number;
  generated: number;
  scheduled: number;
  errors: number;
}

export async function runDailyAutopilot(projectId: string): Promise<AutopilotResult> {
  const scope = systemScope('daily autopilot');
  const project = await db().get(scope, 'projects', projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const steps: AutomationStep[] = [];
  let run = await db().insert(scope, 'automation_runs', {
    id: newId(),
    project_id: projectId,
    kind: 'daily',
    started_at: nowIso(),
    finished_at: null,
    status: 'running',
    steps: [],
    summary: null,
  });

  let queuedToPublish = 0;
  let generated = 0;
  let scheduled = 0;
  let errors = 0;

  const step = async (
    name: string,
    fn: () => Promise<{ detail: string; skipped?: boolean }>,
  ): Promise<void> => {
    const started = Date.now();
    try {
      const { detail, skipped } = await fn();
      steps.push({
        name,
        status: skipped ? 'skipped' : 'ok',
        detail,
        duration_ms: Date.now() - started,
      });
    } catch (e) {
      errors++;
      const message = e instanceof Error ? e.message : String(e);
      steps.push({ name, status: 'failed', detail: message, duration_ms: Date.now() - started });
      await recordError(scope, {
        projectId,
        runId: run.id,
        scope: `autopilot:${name}`,
        message,
        remedy: (e as { remedy?: string })?.remedy ?? null,
        fatal: false,
      });
      log.warn('autopilot step failed', { projectId, step: name, error: message });
    }
  };

  if (project.status === 'paused') {
    await db().update(scope, 'automation_runs', run.id, {
      status: 'succeeded',
      finished_at: nowIso(),
      steps: [{ name: 'Paused', status: 'skipped', detail: 'Project is paused', duration_ms: 0 }],
      summary: 'Project is paused — autopilot took no action.',
    });
    return { run, queuedToPublish: 0, generated: 0, scheduled: 0, errors: 0 };
  }

  /* 1. Connections. */
  let healthyPlatforms: Platform[] = [];
  await step('Check social connections', async () => {
    const health = await checkAllConnections(projectId);
    healthyPlatforms = (await db().find(scope, 'social_accounts', {
      where: { project_id: projectId, status: 'connected' },
    })).map((a) => a.platform);

    for (const platform of healthyPlatforms) {
      // A platform that just came back gets its stalled queue released.
      const resumed = await resumeAfterReconnect(scope, projectId, platform);
      if (resumed) scheduled += resumed;
    }

    if (health.needsAttention.length) {
      return {
        detail: `${health.healthy} healthy; ${health.needsAttention
          .map((n) => `${n.platform} needs attention`)
          .join(', ')}`,
      };
    }
    return { detail: `${health.healthy} platform(s) connected and healthy` };
  });

  /* 2. Upcoming posts. */
  let runway = { queued: 0, daysOfRunway: 0, lastScheduledAt: null as string | null };
  await step('Check upcoming posts', async () => {
    runway = await queueDepth(scope, projectId);
    return {
      detail: `${runway.queued} posts queued, ${runway.daysOfRunway} days of runway`,
    };
  });

  /* 3 & 4. Generate missing content (quality control runs inside generation). */
  await step('Generate missing content', async () => {
    if (runway.daysOfRunway >= MIN_RUNWAY_DAYS) {
      return { detail: `Runway is ${runway.daysOfRunway} days — nothing needed`, skipped: true };
    }
    const result = await topUpContent(scope, project, TOPUP_WINDOW_DAYS);
    generated += result.generated;
    return {
      detail:
        result.generated > 0
          ? `Generated ${result.generated} posts (${result.rejectedDuplicates} duplicates rejected, ${result.blockedByQc} held for review)`
          : result.reason,
      skipped: result.generated === 0,
    };
  });

  /* 4. Quality control sweep over anything still in draft. */
  await step('Run quality control', async () => {
    const reviewed = await sweepQualityControl(scope, project);
    return {
      detail: `${reviewed.checked} checked, ${reviewed.approved} approved, ${reviewed.held} held for review`,
      skipped: reviewed.checked === 0,
    };
  });

  /* 5. Publish anything due — as jobs, one post each. */
  await step('Publish scheduled content', async () => {
    const due = await dueScheduledPosts(scope, nowIso(), 50);
    const mine = due.filter((p) => p.project_id === projectId);
    if (mine.length === 0) return { detail: 'Nothing due right now', skipped: true };

    let queued = 0;
    for (const post of mine) {
      if (post.next_attempt_at && Date.parse(post.next_attempt_at) > Date.now()) continue;
      const { created } = await enqueueOnce(
        scope,
        'publish_post',
        { scheduledPostId: post.id, projectId, idempotencyKey: post.id },
        { projectId, dedupeKey: post.id },
      );
      if (created) queued++;
    }
    queuedToPublish += queued;
    // Each of these is its own durable job, published one per worker pass. The
    // daily loop never waits on Instagram itself.
    return { detail: `${queued} post(s) queued to publish`, skipped: queued === 0 };
  });

  /* 6. Analytics. */
  await step('Collect analytics', async () => {
    if (healthyPlatforms.length === 0) {
      return { detail: 'No connected platforms to read from', skipped: true };
    }
    const result = await collectAnalytics(scope, projectId);
    return {
      detail: `${result.postsCollected} post snapshots, ${result.accountsCollected} account snapshots`,
      skipped: result.postsCollected === 0 && result.accountsCollected === 0,
    };
  });

  /* 7, 8 & 11. Evaluate, decide, and act on the mix. */
  let opportunityBrief: string | null = null;
  await step('Evaluate performance and optimize', async () => {
    const result = await optimize(scope, project);
    if (result.postsAnalyzed === 0) {
      return { detail: 'No published posts to learn from yet', skipped: true };
    }
    const generateAction = result.recommendations.find(
      (r) => r.action.type === 'generate_content',
    );
    if (generateAction && generateAction.action.type === 'generate_content') {
      opportunityBrief = generateAction.action.brief;
    }
    return {
      detail:
        `Analysed ${result.postsAnalyzed} posts; ${result.recommendations.length} recommendations, ` +
        `${result.applied.length} applied automatically`,
    };
  });

  /* 8. Opportunities. */
  await step('Identify opportunities', async () => {
    const analysis = await getAnalysis(scope, projectId);
    if (!analysis) return { detail: 'No product analysis yet', skipped: true };
    const trends = await scanTrends(scope, projectId, analysis);
    return {
      detail: `${trends.participatable.length} of ${trends.signals.length} signals are worth acting on`,
      skipped: trends.signals.length === 0,
    };
  });

  /* 9 & 10. Extra content from the optimizer's brief, then schedule everything. */
  await step('Generate and schedule future content', async () => {
    if (opportunityBrief) {
      const extra = await topUpContent(scope, project, 7, opportunityBrief, 'optimizer');
      generated += extra.generated;
    }

    const approved = await db().find(scope, 'content_items', {
      where: { project_id: projectId, status: 'approved' },
    });
    if (approved.length === 0) {
      return { detail: 'Nothing approved and waiting', skipped: true };
    }
    const result = await scheduleContent(scope, project, approved);
    scheduled += result.scheduled.length;
    return {
      detail: `${result.scheduled.length} scheduled, ${result.skipped.length} skipped`,
    };
  });

  const status: AutomationRun['status'] =
    errors === 0 ? 'succeeded' : errors < steps.length ? 'partial' : 'failed';

  const summary =
    `Queued ${queuedToPublish} to publish, generated ${generated}, scheduled ${scheduled}` +
    (errors ? `, ${errors} step(s) had problems` : '');

  run = await db().update(scope, 'automation_runs', run.id, {
    status,
    finished_at: nowIso(),
    steps,
    summary,
  });

  await db().update(scope, 'projects', projectId, {
    last_autopilot_run_at: nowIso(),
    updated_at: nowIso(),
    status: queuedToPublish > 0 || scheduled > 0 ? 'live' : project.status,
  });

  log.info('autopilot run complete', { projectId, status, queuedToPublish, generated, scheduled, errors });
  return { run, queuedToPublish, generated, scheduled, errors };
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

interface TopUpResult {
  generated: number;
  rejectedDuplicates: number;
  blockedByQc: number;
  reason: string;
  /** Slots in the window still waiting to be written. Drives the next batch. */
  remainingSlots: number;
  /** Set when the run could not start. Absent when it ran and simply found nothing. */
  blocker?: GenerationBlocker;
}

/**
 * The preconditions generation needs, read without running it.
 *
 * Returns the first thing standing in the way, or null when the machine is
 * ready to write. The calendar calls this to say so up front; `topUpContent`
 * calls it so the two can never disagree about what is wrong.
 */
export async function generationBlocker(
  scope: TenantScope,
  project: Project,
): Promise<GenerationBlocker | null> {
  const [analysis, strategy, brand] = await Promise.all([
    getAnalysis(scope, project.id),
    getStrategy(scope, project.id),
    getBrandProfile(scope, project.id),
  ]);
  if (!analysis) return blocker('no_analysis');
  if (!strategy) return blocker('no_strategy');
  if (!strategy.approved) return blocker('strategy_unapproved');
  if (!brand) return blocker('no_brand');
  if ((await publishablePlatforms(scope, project, strategy)).length === 0) {
    return blocker('no_platform');
  }
  return null;
}

/**
 * Platforms to plan for: the connected ones first, then anything else the
 * strategy targets.
 *
 * Building the calendar is step three; connecting accounts is step four, and
 * Meta's app review can take weeks — a founder should see their content in the
 * meantime. Publishing is where a missing connection is surfaced, with a
 * remedy, so nothing here can quietly post into the void.
 */
async function publishablePlatforms(
  scope: TenantScope,
  project: Project,
  strategy: { platform_strategy: { platform: Platform }[] },
): Promise<Platform[]> {
  const connected = await db().find(scope, 'social_accounts', {
    where: { project_id: project.id, status: 'connected' },
  });
  const connectedPlatforms = connected.map((a) => a.platform);
  const targeted = strategy.platform_strategy
    .map((p) => p.platform)
    .filter((p) => LIVE_PLATFORMS.includes(p));

  return [
    ...connectedPlatforms.filter((p) => LIVE_PLATFORMS.includes(p)),
    ...targeted.filter((p) => !connectedPlatforms.includes(p)),
  ];
}

/** Fills open calendar slots with new content. */
export async function topUpContent(
  scope: TenantScope,
  project: Project,
  days: number,
  brief?: string,
  origin: ContentItem['origin'] = 'autopilot',
): Promise<TopUpResult> {
  const empty = (reason: string, remainingSlots = 0): TopUpResult => ({
    generated: 0,
    rejectedDuplicates: 0,
    blockedByQc: 0,
    reason,
    remainingSlots,
  });

  // One check, shared with the calendar page, so the button and the page can
  // never give different answers about why nothing is being written.
  const blocked = await generationBlocker(scope, project);
  if (blocked) return { ...empty(blocked.message), blocker: blocked };

  const [strategy, brand, analysis] = await Promise.all([
    getStrategy(scope, project.id),
    getBrandProfile(scope, project.id),
    getAnalysis(scope, project.id),
  ]);
  // generationBlocker returning null established all three are present.
  if (!strategy || !brand || !analysis) return empty('Nothing to generate from');

  const [personas, pillars, campaigns, platforms] = await Promise.all([
    listPersonas(scope, project.id),
    listPillars(scope, project.id),
    listCampaigns(scope, project.id),
    publishablePlatforms(scope, project, strategy),
  ]);

  const slots = await openSlots(scope, {
    project,
    strategy,
    days: days as 7 | 14 | 30 | 60 | 90,
    platforms,
  });
  if (slots.length === 0) return empty('The calendar is already full for this window');

  const result = await generateContent(scope, {
    project,
    analysis,
    brand,
    strategy,
    personas,
    pillars,
    campaigns,
    slots,
    origin,
    brief,
  });

  return {
    generated: result.created.length,
    rejectedDuplicates: result.rejectedDuplicates,
    blockedByQc: result.blockedByQc,
    reason: result.created.length ? 'Generated' : 'Nothing new passed the duplicate check',
    remainingSlots: result.remainingSlots,
  };
}

/** Re-checks drafts and promotes anything the mode allows. */
async function sweepQualityControl(
  scope: TenantScope,
  project: Project,
): Promise<{ checked: number; approved: number; held: number }> {
  const drafts = await db().find(scope, 'content_items', {
    where: { project_id: project.id },
    whereIn: { status: ['draft', 'review_required'] },
    limit: 50,
  });
  if (drafts.length === 0) return { checked: 0, approved: 0, held: 0 };

  const [analysis, brand, settings, pillars] = await Promise.all([
    getAnalysis(scope, project.id),
    getBrandProfile(scope, project.id),
    getSettings(scope, project.id),
    listPillars(scope, project.id),
  ]);

  let approved = 0;
  let held = 0;

  for (const item of drafts) {
    const qc = runQualityControl({ item, analysis, brand });
    const pillarType = pillars.find((p) => p.id === item.pillar_id)?.type ?? 'education';
    const decision = canAutoPublish(
      qc,
      project.autopilot_mode,
      pillarType,
      settings?.require_approval_for_promotion ?? true,
    );

    const status: ContentItem['status'] = !qc.passed
      ? 'review_required'
      : decision.allowed
        ? 'approved'
        : 'approval_required';

    await db().update(scope, 'content_items', item.id, { qc, status, updated_at: nowIso() });
    if (status === 'approved') approved++;
    else held++;
  }

  if (held > 0) {
    await notify(scope, {
      user_id: project.user_id,
      project_id: project.id,
      severity: 'info',
      title: `${held} post${held === 1 ? '' : 's'} waiting on you`,
      body:
        project.autopilot_mode === 'manual'
          ? 'Manual mode means nothing publishes without your approval.'
          : 'These were held by quality control or your approval settings.',
      action_label: 'Review them',
      action_href: '/app/content?status=approval_required',
    });
  }

  return { checked: drafts.length, approved, held };
}

/** Every project that autopilot should touch on this pass. */
export async function projectsForAutopilot(): Promise<Project[]> {
  const scope = systemScope('autopilot scan');
  const all = await db().find(scope, 'projects', {});
  return all.filter(
    (p) => p.status !== 'paused' && p.status !== 'created' && p.autopilot_mode !== 'manual',
  );
}

/**
 * Turns every due post into its own durable job.
 *
 * This sweep used to publish inline — up to forty posts, each of which waits
 * on Meta transcoding a video, inside one HTTP request. That is the shape that
 * gets killed half-way through, and the half that ran left `publishing` rows
 * nobody would look at again. Now the sweep only writes jobs; the worker
 * publishes one post per pass, and a post that fails takes nothing else down
 * with it.
 */
export async function enqueueDuePublishJobs(
  limit = 50,
): Promise<{ due: number; queued: number; recovered: number }> {
  const scope = systemScope('publish sweep');
  const due = await dueScheduledPosts(scope, nowIso(), limit);
  const stranded = await strandedPublishes(scope);
  let queued = 0;

  for (const post of [...due, ...stranded]) {
    // A post held for a backoff window is not due yet.
    if (post.next_attempt_at && Date.parse(post.next_attempt_at) > Date.now()) continue;
    const { created } = await enqueueOnce(
      scope,
      'publish_post',
      { scheduledPostId: post.id, projectId: post.project_id, idempotencyKey: post.id },
      { projectId: post.project_id, dedupeKey: post.id },
    );
    if (created) queued++;
  }

  if (queued) log.info('publish jobs queued', { due: due.length, stranded: stranded.length, queued });
  return { due: due.length, queued, recovered: stranded.length };
}

/**
 * How long a post may sit mid-publish before it is treated as abandoned.
 *
 * Comfortably beyond a worker's lease, so a post another worker is genuinely
 * holding is never taken from it. Re-publishing is safe regardless — the
 * publisher asks Instagram whether the attempt already went live before it
 * tries again — but taking the post back early would still mean two workers
 * doing the same work.
 */
const STRANDED_PUBLISH_MS = 15 * 60_000;

/**
 * Posts left mid-publish by a worker that never came back.
 *
 * `publishing` is not a state anything sweeps up otherwise: the post is not
 * due (its slot has passed) and not failed (nothing recorded a failure), so
 * without this it would sit there indefinitely, showing as going out.
 */
async function strandedPublishes(scope: TenantScope): Promise<ScheduledPost[]> {
  const cutoff = new Date(Date.now() - STRANDED_PUBLISH_MS).toISOString();
  const publishing = await db().find(scope, 'scheduled_posts', {
    where: { status: 'publishing' },
    limit: 50,
  });
  return publishing.filter((p) => (p.started_at ?? p.created_at) < cutoff);
}

/** Used by the "check my connections" button and the health cron. */
export async function verifyConnection(
  projectId: string,
  platform: Platform,
): Promise<{ ok: boolean; detail: string }> {
  const scope = systemScope('connection verify');
  try {
    await getUsableConnection(scope, projectId, platform);
    return { ok: true, detail: 'Connected and ready' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
