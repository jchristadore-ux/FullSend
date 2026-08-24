/**
 * A standalone background worker.
 *
 * An alternative to the /api/cron/* endpoints for anyone not deploying to a
 * platform with cron. Runs the same queue drain and the same daily and weekly
 * loops, in a long-lived process.
 *
 *   npm run worker
 */
import './script-env';

import { systemScope } from '../src/lib/db';
import { db, enqueue } from '../src/lib/db/repo';
import { drainQueue, queueStats } from '../src/lib/jobs/runner';
import { projectsForAutopilot, publishDuePosts } from '../src/lib/automation/autopilot';
import { nowIso } from '../src/lib/ids';

const QUEUE_INTERVAL_MS = 30_000;
const PUBLISH_INTERVAL_MS = 5 * 60_000;
const DAILY_INTERVAL_MS = 24 * 60 * 60_000;
const WEEKLY_INTERVAL_MS = 7 * DAILY_INTERVAL_MS;

let running = true;

function log(message: string, meta?: Record<string, unknown>): void {
  const line = { ts: nowIso(), scope: 'worker', message, ...(meta ? { meta } : {}) };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}

async function everyDay(): Promise<void> {
  const scope = systemScope('worker:daily');
  const projects = await projectsForAutopilot();
  for (const p of projects) {
    await enqueue(scope, 'daily_autopilot', { projectId: p.id }, { projectId: p.id });
  }
  log('daily autopilot enqueued', { projects: projects.length });
}

async function everyWeek(): Promise<void> {
  const scope = systemScope('worker:weekly');
  const projects = await projectsForAutopilot();
  for (const p of projects) {
    await enqueue(scope, 'weekly_report', { projectId: p.id }, { projectId: p.id });
  }
  log('weekly reports enqueued', { projects: projects.length });
}

async function main(): Promise<void> {
  log('FullSend worker started', {
    dbDriver: process.env.FULLSEND_DB_DRIVER,
    aiProvider: process.env.FULLSEND_AI_PROVIDER,
  });

  if (process.env.FULLSEND_DB_DRIVER === 'memory') {
    log('WARNING: running against the in-memory store — nothing survives a restart');
  }

  const timers = [
    setInterval(() => {
      void drainQueue({ max: 20, budgetMs: 25_000 }).then((r) => {
        if (r.processed) log('queue drained', r);
      });
    }, QUEUE_INTERVAL_MS),

    setInterval(() => {
      void publishDuePosts(40).then((r) => {
        if (r.published || r.failed) log('publish sweep', r);
      });
    }, PUBLISH_INTERVAL_MS),

    setInterval(() => void everyDay(), DAILY_INTERVAL_MS),
    setInterval(() => void everyWeek(), WEEKLY_INTERVAL_MS),
  ];

  const shutdown = async () => {
    if (!running) return;
    running = false;
    for (const t of timers) clearInterval(t);
    const stats = await queueStats().catch(() => null);
    log('worker stopping', stats ?? {});
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Run one pass immediately rather than waiting for the first tick.
  await drainQueue({ max: 20, budgetMs: 25_000 });
  void db;
}

main().catch((e) => {
  log('worker crashed', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
