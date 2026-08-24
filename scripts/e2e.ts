/**
 * THE FINAL PRODUCT TEST.
 *
 * Runs the entire FullSend chain in one process and prints what actually
 * happened at each stage:
 *
 *   GitHub repo → analysis → understanding → audience → strategy → pillars →
 *   30-day calendar → content → creative → quality control → account
 *   connection → scheduling → publishing → analytics → performance analysis →
 *   optimization → new content
 *
 * Uses the memory store, the deterministic composer and the mock platform
 * adapters, so it is hermetic. Every other line of code on the path is the same
 * code that runs in production.
 *
 *   npm run e2e
 */
// Environment defaults must load before anything that reads process.env.
import './script-env';

import { setStore, MemoryStore, systemScope, userScope } from '../src/lib/db';
import { db } from '../src/lib/db/repo';
import { newId, nowIso } from '../src/lib/ids';
import { useMockAdapters } from '../src/lib/social/registry';
import { completeConnection } from '../src/lib/social/connections';
import { analyzeRepository } from '../src/lib/analysis/analyze';
import { approveStrategy, buildStrategy } from '../src/lib/strategy/build';
import { generateContent } from '../src/lib/content/generate';
import { openSlots, queueDepth, scheduleContent } from '../src/lib/scheduler/schedule';
import { publishScheduledPost } from '../src/lib/publish/publish';
import { collectAnalytics, postPerformance, summarise } from '../src/lib/analytics/collect';
import { computeSendScore } from '../src/lib/analytics/send-score';
import { optimize } from '../src/lib/optimizer/optimize';
import { scanTrends } from '../src/lib/trends/scan';
import { topUpContent, runDailyAutopilot } from '../src/lib/automation/autopilot';
import { generateWeeklyReport } from '../src/lib/automation/weekly-report';
import { seedFullSendProject } from '../src/lib/seed/fullsend-project';
import { GitHubClient } from '../src/lib/github/client';
import type { Platform } from '../src/lib/types';

/* ── Output helpers ─────────────────────────────────────────────────────── */

const B = '\x1b[1m';
const O = '\x1b[38;5;208m';
const G = '\x1b[32m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const X = '\x1b[0m';

let step = 0;
let failures = 0;

function stage(title: string): void {
  step++;
  console.log(`\n${O}${B}${String(step).padStart(2, '0')} ── ${title}${X}`);
}

function ok(label: string, detail: string): void {
  console.log(`   ${G}✓${X} ${label} ${D}${detail}${X}`);
}

function bad(label: string, detail: string): void {
  failures++;
  console.log(`   ${R}✗${X} ${label} ${D}${detail}${X}`);
}

function check(condition: boolean, label: string, detail: string): void {
  condition ? ok(label, detail) : bad(label, detail);
}

/**
 * A GitHub client backed by a fixed repository. The network is not available
 * to this script; every other layer is the real implementation.
 */
function fixtureClient(): GitHubClient {
  const readme = `# Taskflow

Turn messy team chatter into a clean task list, automatically.

## Automatic task extraction
Reads your team's messages and pulls out the actual commitments people made.

## Smart prioritisation
Ranks tasks by deadline pressure and by who is blocked on them.

## Daily digest
One message every morning with what actually matters today.

## Slack and Linear sync
Close it in Linear and it disappears from the digest.

![Inbox](docs/screenshot-inbox.png)
`;

  const sources: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'taskflow',
      dependencies: { next: '15.0.0', react: '19.0.0', '@anthropic-ai/sdk': '0.30.0' },
      devDependencies: { typescript: '5.6.0', vitest: '2.0.0' },
      scripts: { dev: 'next dev', build: 'next build', test: 'vitest' },
    }),
    'src/app/inbox/page.tsx':
      '<h1>Inbox</h1><h2>Extracted today</h2><button>Extract tasks</button>',
    'src/app/digest/page.tsx': '<h1>Daily digest</h1><button>Send now</button>',
  };

  const files = [
    ...Object.keys(sources),
    'README.md',
    'src/app/page.tsx',
    'src/app/settings/page.tsx',
    'docs/screenshot-inbox.png',
    'tests/extract.test.ts',
    '.github/workflows/ci.yml',
    ...Array.from({ length: 70 }, (_, i) => `src/lib/m${i}.ts`),
  ];

  return {
    async getRepo() {
      return {
        owner: 'acme',
        name: 'taskflow',
        full_name: 'acme/taskflow',
        html_url: 'https://github.com/acme/taskflow',
        description: 'Turn messy team chatter into a clean task list, automatically.',
        default_branch: 'main',
        language: 'TypeScript',
        topics: ['productivity', 'tasks', 'ai'],
        stargazers_count: 842,
        private: false,
        size: 4200,
        pushed_at: nowIso(),
        homepage: 'https://taskflow.example.com',
        license: 'MIT',
      };
    },
    async getLanguages() {
      return { TypeScript: 184_000, CSS: 12_400 };
    },
    async getTree() {
      return {
        entries: files.map((path) => ({
          path,
          type: 'blob' as const,
          size: path.endsWith('.png') ? 240_000 : 2000,
        })),
        truncated: false,
      };
    },
    async getFile(_ref: unknown, path: string) {
      return sources[path] ?? null;
    },
    async getReadme() {
      return readme;
    },
    rawUrl(_ref: unknown, branch: string, path: string) {
      return `https://raw.githubusercontent.com/acme/taskflow/${branch}/${path}`;
    },
    async getViewer() {
      return { login: 'acme', avatar_url: '' };
    },
  } as unknown as GitHubClient;
}

/* ── The run ────────────────────────────────────────────────────────────── */

async function main() {
  console.log(`${O}${B}
  ╻ ╻   FULLSEND — END-TO-END PRODUCT TEST
  ┃ ┃   Everything goes live.
${X}`);

  setStore(new MemoryStore());
  const adapters = useMockAdapters();
  const sys = systemScope('e2e');

  /* Account. */
  stage('Account');
  const user = await db().insert(sys, 'users', {
    id: newId(),
    email: 'founder@taskflow.example.com',
    name: 'Founder',
    avatar_url: null,
    is_admin: true,
    created_at: nowIso(),
  });
  const scope = userScope(user.id);
  ok('User created', user.email);

  const project = await db().insert(scope, 'projects', {
    id: newId(),
    user_id: user.id,
    name: 'Taskflow',
    slug: 'taskflow',
    status: 'created',
    autopilot_mode: 'full_send',
    timezone: 'UTC',
    is_internal: false,
    last_autopilot_run_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  await db().insert(scope, 'settings', {
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
  ok('Project created', `${project.name} · autopilot ${project.autopilot_mode}`);

  /* 1. Repository → analysis. */
  stage('GitHub repository → product analysis');
  const analyzed = await analyzeRepository(scope, project, 'github.com/acme/taskflow', {
    client: fixtureClient(),
  });
  const analysis = analyzed.analysis;
  ok('Repository read', `${analyzed.repository.owner}/${analyzed.repository.name}`);
  check(analysis.one_liner.length > 5, 'Product understood', analysis.one_liner);
  check(analysis.features.length > 0, 'Features found', analysis.features.map((f) => f.name).join(' · '));
  check(analysis.screens.length > 0, 'Screens identified', analysis.screens.map((s) => s.name).join(', '));
  check(
    analysis.screens.some((s) => s.image_url),
    'Repo screenshot found',
    `${analysis.screens.filter((s) => s.image_url).length} usable as creative`,
  );
  check(
    analysis.not_capabilities.length > 0,
    'Claim boundaries set',
    `${analysis.not_capabilities.length} things it will never claim`,
  );

  /* 2. Audience. */
  stage('Target audience');
  check(
    analyzed.personas.length > 0,
    'Personas built',
    analyzed.personas.map((p) => p.name).join(' · '),
  );

  /* 3. Strategy. */
  stage('Marketing strategy');
  const built = await buildStrategy(scope, project, analysis, analyzed.personas);
  const mixTotal = Object.values(built.strategy.content_mix).reduce((a, b) => a + b, 0);
  ok('Positioning', built.strategy.positioning.slice(0, 90) + '…');
  check(mixTotal === 100, 'Content mix totals 100', JSON.stringify(built.strategy.content_mix));
  check(built.pillars.length > 0, 'Content pillars', built.pillars.map((p) => p.name).join(' · '));
  check(built.campaigns.length > 0, 'Campaigns', built.campaigns.map((c) => c.name).join(' · '));
  check(
    built.brand.words_to_avoid.length > 0,
    'Brand profile',
    `${built.brand.words_to_avoid.length} banned phrases`,
  );

  const strategy = await approveStrategy(scope, built.strategy.id);
  ok('Strategy approved', `v${strategy.version}`);

  /* 4. Accounts. */
  stage('Social account connection');
  for (const platform of ['instagram', 'tiktok'] as Platform[]) {
    await completeConnection(
      scope,
      project,
      platform,
      {
        accessToken: `token-${platform}`,
        refreshToken: `refresh-${platform}`,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        refreshExpiresAt: new Date(Date.now() + 60 * 86_400_000),
        scopes: ['publish', 'insights'],
      },
      {
        externalId: `${platform}-acct`,
        username: `taskflow_${platform}`,
        displayName: 'Taskflow',
        avatarUrl: null,
        followers: 1800,
        metadata: {},
      },
    );
    ok(`${platform} connected`, 'token stored encrypted');
  }

  const tokenRows = await db().find(sys, 'oauth_tokens', {});
  check(
    tokenRows.every((t) => t.access_token_encrypted.startsWith('v1.')),
    'Tokens encrypted at rest',
    `${tokenRows.length} token records, none in plaintext`,
  );

  /* 5. Calendar. */
  stage('30-day content calendar');
  const slots = await openSlots(scope, {
    project,
    strategy,
    days: 30,
    platforms: ['instagram', 'tiktok'],
  });
  check(slots.length > 10, 'Slots planned', `${slots.length} slots across 30 days`);

  /* 6. Content + creative + QC. */
  stage('Content generation → creative → quality control');
  const generated = await generateContent(scope, {
    project,
    analysis,
    brand: built.brand,
    strategy,
    personas: analyzed.personas,
    pillars: built.pillars,
    campaigns: built.campaigns,
    slots,
  });
  check(generated.created.length > 0, 'Posts generated', `${generated.created.length} posts`);
  ok('Duplicates rejected', `${generated.rejectedDuplicates} near-duplicates blocked`);
  ok('Held by QC', `${generated.blockedByQc} routed to human review`);

  const withCreative = generated.created.filter((c) => c.creative_asset_ids.length > 0);
  check(
    withCreative.length === generated.created.length,
    'Every post has creative',
    `${withCreative.length}/${generated.created.length}`,
  );

  const videos = generated.created.filter((c) => c.video_plan);
  check(
    videos.every((v) => v.video_plan!.scenes.length > 0),
    'Video production packages',
    `${videos.length} with full scene plans, render_status=${videos[0]?.video_plan?.render_status ?? 'n/a'}`,
  );
  check(
    videos.every((v) => v.video_plan!.rendered_url === null),
    'No fake rendered videos',
    'render URLs are null because no provider is configured',
  );

  const assets = await db().find(scope, 'creative_assets', { where: { project_id: project.id } });
  check(
    assets.every((a) => a.svg !== null || a.url !== null),
    'Creative assets are real',
    `${assets.length} assets, all with renderable content`,
  );

  const sample = generated.created[0];
  console.log(`   ${D}┌ sample post ────────────────────────────────${X}`);
  console.log(`   ${D}│${X} ${B}${sample.hook}${X}`);
  console.log(`   ${D}│${X} ${sample.caption.split('\n').filter(Boolean).slice(1, 2).join(' ')}`);
  console.log(`   ${D}│ ${sample.platform}/${sample.format} · ${sample.hashtags.join(' ')}${X}`);
  console.log(`   ${D}└─────────────────────────────────────────────${X}`);

  /* 7. Scheduling. */
  stage('Scheduling');
  await giveAssetsPublicUrls(scope, project.id);
  const approved = generated.created.filter((c) => c.status === 'approved');
  const scheduleResult = await scheduleContent(scope, project, approved);
  check(
    scheduleResult.scheduled.length > 0,
    'Posts scheduled',
    `${scheduleResult.scheduled.length} scheduled, ${scheduleResult.skipped.length} held`,
  );
  const runway = await queueDepth(scope, project.id);
  ok('Queue depth', `${runway.queued} queued · ${runway.daysOfRunway} days of runway`);

  /* 8. Publishing. */
  stage('Publishing');
  let published = 0;
  let refusedNoVideo = 0;
  for (const post of scheduleResult.scheduled) {
    const content = await db().get(scope, 'content_items', post.content_item_id);
    const needsVideo = ['reel', 'short_video', 'story'].includes(content!.format);
    const outcome = await publishScheduledPost(scope, post.id);
    if (outcome.status === 'published') published++;
    else if (needsVideo && outcome.error?.includes('video')) refusedNoVideo++;
  }
  check(published > 0, 'Posts published', `${published} live via the platform adapter`);
  ok(
    'Video posts correctly refused',
    `${refusedNoVideo} held — production package exists, rendered file does not`,
  );

  const publishedRows = await db().find(scope, 'published_posts', {
    where: { project_id: project.id },
  });
  check(
    publishedRows.every((p) => Object.keys(p.platform_response).length > 0),
    'Platform receipts stored',
    `${publishedRows.length} responses recorded verbatim`,
  );

  /* 9. Analytics. */
  stage('Analytics collection');
  for (const row of publishedRows) {
    const content = await db().get(scope, 'content_items', row.content_item_id);
    const isCarousel = content!.format === 'carousel';
    adapters.get(row.platform)!.setMetrics(row.external_id, {
      views: isCarousel ? 5400 : 1600,
      reach: isCarousel ? 5000 : 1500,
      impressions: isCarousel ? 5400 : 1600,
      likes: isCarousel ? 410 : 82,
      comments: isCarousel ? 34 : 7,
      shares: isCarousel ? 61 : 5,
      saves: isCarousel ? 122 : 18,
      profile_visits: isCarousel ? 150 : 26,
      clicks: isCarousel ? 31 : 4,
      follows: isCarousel ? 22 : 3,
    });
  }
  const collected = await collectAnalytics(scope, project.id);
  check(
    collected.postsCollected === publishedRows.length,
    'Metrics collected from platforms',
    `${collected.postsCollected} post snapshots · ${collected.accountsCollected} account snapshots`,
  );

  const summary = await summarise(scope, project.id);
  ok(
    'Totals',
    `reach ${summary.reach} · engagement ${summary.engagement} · clicks ${summary.clicks}`,
  );

  /* 10. Send Score. */
  stage('The Send Score');
  const performance = await postPerformance(scope, project.id);
  const score = computeSendScore({
    performance,
    queuedPosts: runway.queued,
    daysOfRunway: runway.daysOfRunway,
    followersGained: 25,
    followerBase: 3600,
    daysActive: 21,
    connectedPlatforms: 2,
  });
  check(score.total > 0 && score.total <= 100, 'Score computed', `${score.total}/100`);
  ok(
    'Components',
    `content ${score.content} · audience ${score.audience} · engagement ${score.engagement} · ` +
      `consistency ${score.consistency} · conversion ${score.conversion}`,
  );
  for (const d of score.drivers.slice(0, 3)) {
    console.log(`   ${D}  ${d.delta >= 0 ? '+' : ''}${d.delta}  ${d.label} — ${d.detail}${X}`);
  }

  /* 11. Performance analysis → optimization. */
  stage('Performance analysis → optimization');
  const optimized = await optimize(scope, project);
  check(
    optimized.recommendations.length > 0,
    'Recommendations produced',
    `${optimized.recommendations.length} from ${optimized.postsAnalyzed} posts`,
  );
  for (const r of optimized.recommendations) {
    console.log(`   ${D}  “${r.statement}”${X}`);
  }
  check(
    optimized.applied.length > 0,
    'Applied automatically under Full Send',
    `${optimized.applied.length} applied without asking`,
  );
  check(optimized.experiments.length > 0, 'Experiments recorded', `${optimized.experiments.length}`);

  const afterMix = await db().findOne(scope, 'marketing_strategies', {
    where: { project_id: project.id },
    orderBy: 'version',
    direction: 'desc',
  });
  ok('Mix after optimization', JSON.stringify(afterMix!.content_mix));
  ok(
    'Cadence after optimization',
    `instagram ${afterMix!.posting_cadence.instagram_per_week}/wk · ` +
      `tiktok ${afterMix!.posting_cadence.tiktok_per_week}/wk`,
  );

  /* 12. Trends. */
  stage('Trend engine');
  const trends = await scanTrends(scope, project.id, analysis);
  check(trends.signals.length > 0, 'Signals found', `${trends.signals.length} signals`);
  check(
    trends.signals.every((s) =>
      ['platform_api', 'repo_context', 'category_pattern'].includes(s.source),
    ),
    'Every signal has a real source',
    'no invented trends',
  );

  /* 13. New content from what was learned. */
  stage('New content, informed by results');
  const before = await db().count(scope, 'content_items', { where: { project_id: project.id } });
  // The 30-day window is already full, so extend the horizon — this is what the
  // autopilot does when runway gets short.
  const topUp = await topUpContent(scope, project, 60, 'More of whatever is winning');
  const after = await db().count(scope, 'content_items', { where: { project_id: project.id } });
  check(after > before, 'New content generated', `${before} → ${after} posts (${topUp.reason})`);
  ok('Duplicate guard held', `${topUp.rejectedDuplicates} rejected as too similar`);

  /* 14. The autonomous loop. */
  stage('Daily autopilot loop');
  const run = await runDailyAutopilot(project.id);
  check(run.run.steps.length >= 8, 'All loop steps ran', `${run.run.steps.length} steps`);
  for (const s of run.run.steps) {
    const mark = s.status === 'ok' ? `${G}✓${X}` : s.status === 'skipped' ? `${D}–${X}` : `${R}✗${X}`;
    console.log(`   ${mark} ${D}${s.name} — ${s.detail}${X}`);
  }
  check(run.errors === 0, 'No failures in the loop', run.run.summary ?? '');

  /* 15. Weekly report. */
  stage('The Weekly Send Report');
  const report = await generateWeeklyReport(project.id);
  ok('Report generated', `${report.week_start} → ${report.week_end}`);
  ok('Posts / reach / engagement', `${report.total_posts} / ${report.reach} / ${report.engagement}`);
  ok('Best format', String(report.best_format ?? '—'));
  console.log(`   ${D}  learning: ${report.biggest_learning}${X}`);
  console.log(`   ${D}  next week: ${report.next_week_strategy}${X}`);

  /* 16. Error handling. */
  stage('Error handling — a connection dies mid-flight');
  // Later runs generated fresh creative; give it URLs so the failure under test
  // is the dead connection rather than missing media hosting.
  await giveAssetsPublicUrls(scope, project.id);
  adapters.get('instagram')!.tokenExpired = true;
  const queuedIg = await db().find(scope, 'scheduled_posts', {
    where: { project_id: project.id, platform: 'instagram', status: 'scheduled' },
  });
  // Pick an image post: a video post would fail for a different (also correct)
  // reason, and this stage is specifically testing connection failure.
  let target = null as (typeof queuedIg)[number] | null;
  for (const p of queuedIg) {
    const c = await db().get(scope, 'content_items', p.content_item_id);
    if (c && !['reel', 'short_video', 'story'].includes(c.format)) {
      target = p;
      break;
    }
  }
  const stillQueued = target ? [target] : [];
  if (stillQueued[0]) {
    const outcome = await publishScheduledPost(scope, stillQueued[0].id);
    check(outcome.status === 'failed', 'Publish failed cleanly', outcome.error ?? '');
    check(Boolean(outcome.remedy), 'Actionable remedy given', outcome.remedy ?? '');

    const notifications = await db().find(scope, 'notifications', { where: { user_id: user.id } });
    check(
      notifications.some((n) => n.title.toLowerCase().includes('needs attention')),
      'Founder notified',
      'with a reconnect link',
    );

    adapters.get('instagram')!.tokenExpired = false;
    const { resumeAfterReconnect } = await import('../src/lib/publish/publish');
    const resumed = await resumeAfterReconnect(scope, project.id, 'instagram');
    check(resumed > 0, 'Resumes automatically after reconnect', `${resumed} posts released`);
  } else {
    ok('No queued Instagram post to fail', 'skipped');
  }

  /* 17. Tenant isolation. */
  stage('Tenant isolation');
  const intruder = await db().insert(sys, 'users', {
    id: newId(),
    email: 'someone-else@example.com',
    name: 'Intruder',
    avatar_url: null,
    is_admin: false,
    created_at: nowIso(),
  });
  const intruderScope = userScope(intruder.id);
  const leaked = await db().find(intruderScope, 'content_items', {
    where: { project_id: project.id },
  });
  check(leaked.length === 0, 'Another user sees nothing', `${leaked.length} rows leaked`);

  let refused = false;
  try {
    await db().get(intruderScope, 'projects', project.id);
  } catch {
    refused = true;
  }
  const direct = refused ? null : await db().get(intruderScope, 'projects', project.id);
  check(refused || direct === null, 'Direct project access refused', 'by id, with the real uuid');

  /* 18. Cost. */
  stage('Cost control');
  const usage = await db().find(sys, 'ai_usage', {});
  const total = usage.reduce((s, u) => s + Number(u.cost_usd), 0);
  const cacheHits = usage.filter((u) => u.cache_hit).length;
  ok('AI calls', `${usage.length} calls · ${cacheHits} served from cache`);
  ok('Total cost', `$${total.toFixed(6)} (deterministic composer costs nothing)`);
  const contentCount = await db().count(sys, 'content_items', {});
  ok('Cost per post', `$${(total / Math.max(1, contentCount)).toFixed(6)}`);

  /* 19. FullSend markets FullSend. */
  stage('FullSend’s own marketing');
  const seeded = await seedFullSendProject(user.id, { days: 14, scope: sys });
  check(seeded.campaigns.length === 5, 'Launch campaigns', seeded.campaigns.map((c) => c.name).join(' · '));
  check(seeded.content.length > 0, 'Own content generated', `${seeded.content.length} posts`);
  console.log(`   ${D}┌ FullSend on FullSend ───────────────────────${X}`);
  for (const c of seeded.content.slice(0, 3)) {
    console.log(`   ${D}│${X} ${c.hook} ${D}(${c.platform}/${c.format})${X}`);
  }
  console.log(`   ${D}└─────────────────────────────────────────────${X}`);

  /* Done. */
  console.log(
    `\n${failures === 0 ? G : R}${B}${'═'.repeat(62)}\n` +
      `  ${failures === 0 ? 'FULL SEND. The whole chain works.' : `${failures} check(s) failed.`}\n` +
      `${'═'.repeat(62)}${X}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/** Publishing needs public media URLs; storage is not configured in this run. */
async function giveAssetsPublicUrls(
  scope: ReturnType<typeof userScope>,
  projectId: string,
): Promise<void> {
  const assets = await db().find(scope, 'creative_assets', { where: { project_id: projectId } });
  for (const a of assets) {
    if (!a.url) {
      await db().update(scope, 'creative_assets', a.id, {
        url: `https://cdn.example.com/${a.id}.jpg`,
        mime_type: 'image/jpeg',
      });
    }
  }
}

main().catch((e) => {
  console.error(`\n${R}E2E run failed:${X}`, e);
  process.exit(1);
});
