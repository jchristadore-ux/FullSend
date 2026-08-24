import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { activeProject } from '@/lib/active-project';
import { db, latestWeeklyReport, listRecommendations } from '@/lib/db/repo';
import { engagementRate, postPerformance, summarise } from '@/lib/analytics/collect';
import { currentSendScore } from '@/lib/automation/weekly-report';
import { scoreVerdict } from '@/lib/analytics/send-score';
import { groupBy } from '@/lib/optimizer/optimize';
import { formatCompact } from '@/lib/dashboard';
import type { ContentFormat, PillarType, Platform } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Analytics' };

export default async function AnalyticsPage() {
  const session = await requireSession();
  const project = await activeProject(session);
  if (!project) redirect('/onboarding');

  const since = new Date(Date.now() - 28 * 86_400_000).toISOString();
  const [performance, summary, score, report, recommendations, experiments, pillars] =
    await Promise.all([
      postPerformance(session.scope, project.id, since),
      summarise(session.scope, project.id, since),
      currentSendScore(session.scope, project),
      latestWeeklyReport(session.scope, project.id),
      listRecommendations(session.scope, project.id),
      db().find(session.scope, 'experiments', {
        where: { project_id: project.id },
        orderBy: 'created_at',
        direction: 'desc',
        limit: 8,
      }),
      db().find(session.scope, 'content_pillars', { where: { project_id: project.id } }),
    ]);

  const byFormat = groupBy<ContentFormat>(performance, (p) => p.content.format);
  const byPlatform = groupBy<Platform>(performance, (p) => p.content.platform);
  const byPillar = groupBy<PillarType>(
    performance,
    (p) => pillars.find((pl) => pl.id === p.content.pillar_id)?.type ?? null,
  );
  const verdict = scoreVerdict(score.total);
  const top = [...performance].sort((a, b) => b.engagement - a.engagement).slice(0, 5);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-8 sm:py-10">
      <span className="label">Analytics · last 28 days</span>
      <h1 className="mt-2 font-display text-3xl font-extrabold tracking-crush text-mist sm:text-4xl">
        What actually happened.
      </h1>

      {!summary.hasRealData && (
        <p className="mt-5 border border-edge bg-charcoal px-4 py-3 text-sm text-dim">
          No platform metrics yet. Numbers appear here once FullSend has published and collected
          insights from Instagram or TikTok — nothing on this page is estimated.
        </p>
      )}

      {/* Send Score. */}
      <section className="panel mt-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <span className="label">The Send Score</span>
            <div className="mt-2 flex items-baseline gap-3">
              <span className="stat text-7xl text-orange">{score.total}</span>
              <span className="font-display text-xl font-bold text-dimmer">/ 100</span>
            </div>
            <p
              className={[
                'mt-1 font-display text-base font-bold tracking-tight',
                verdict.tone === 'good' ? 'text-live' : verdict.tone === 'ok' ? 'text-warn' : 'text-dim',
              ].join(' ')}
            >
              {verdict.label}
            </p>
          </div>

          <div className="min-w-[260px] flex-1 space-y-2.5">
            {(
              [
                ['Content', score.content],
                ['Audience', score.audience],
                ['Engagement', score.engagement],
                ['Consistency', score.consistency],
                ['Conversion', score.conversion],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex items-center gap-3">
                <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-wider text-dimmer">
                  {label}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-edge">
                  <span className="block h-full bg-orange" style={{ width: `${value}%` }} />
                </span>
                <span className="w-7 shrink-0 text-right font-mono text-[11px] tabular-nums text-mist">
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>

        {score.drivers.length > 0 && (
          <div className="mt-6 border-t border-edge pt-4">
            <span className="label">What&rsquo;s driving it</span>
            <ul className="mt-3 space-y-2">
              {score.drivers.map((d) => (
                <li key={d.label} className="flex items-start gap-3">
                  <span
                    className={[
                      'shrink-0 font-mono text-[11px] tabular-nums',
                      d.delta >= 0 ? 'text-live' : 'text-fail',
                    ].join(' ')}
                  >
                    {d.delta >= 0 ? '+' : ''}
                    {d.delta}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-mist">{d.label}</p>
                    <p className="text-sm text-dim">{d.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Totals. */}
      <section className="mt-6 grid grid-cols-2 gap-px overflow-hidden border border-edge bg-edge sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Published" value={formatCompact(summary.postsPublished)} />
        <Metric label="Reach" value={formatCompact(summary.reach)} />
        <Metric label="Views" value={formatCompact(summary.views)} />
        <Metric label="Engagement" value={formatCompact(summary.engagement)} />
        <Metric label="Clicks" value={formatCompact(summary.clicks)} />
        <Metric label="Followers +" value={formatCompact(summary.followersGained)} />
      </section>

      {/* Breakdowns. */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Breakdown title="By format" rows={byFormat} />
        <Breakdown title="By platform" rows={byPlatform} />
        <Breakdown title="By pillar" rows={byPillar} />
      </div>

      {/* Top posts. */}
      <section className="panel mt-6 p-5 sm:p-6">
        <span className="label">Strongest content</span>
        {top.length === 0 ? (
          <p className="mt-3 text-sm text-dim">Nothing published yet.</p>
        ) : (
          <ol className="mt-4 space-y-0">
            {top.map((p, i) => (
              <li
                key={p.publishedPost.id}
                className="flex items-center gap-4 border-b border-edge py-3 last:border-b-0"
              >
                <span className="stat w-8 shrink-0 text-lg text-orange">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/app/content/${p.content.id}`}
                    className="block truncate text-sm font-semibold text-mist hover:text-orange"
                  >
                    {p.content.hook}
                  </Link>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-dimmer">
                    {p.content.platform} · {p.content.format}
                  </p>
                </div>
                <Cell label="reach" value={formatCompact(p.metrics.reach || p.metrics.views)} />
                <Cell label="eng" value={formatCompact(p.engagement)} />
                <Cell label="rate" value={`${(engagementRate(p.metrics) * 100).toFixed(1)}%`} />
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Experiments. */}
      {experiments.length > 0 && (
        <section className="panel mt-6 p-5 sm:p-6">
          <span className="label">Experiments</span>
          <ul className="mt-4 space-y-3">
            {experiments.map((e) => (
              <li key={e.id} className="border-l-2 border-edge pl-3.5">
                <p className="font-display text-sm font-bold tracking-tight text-mist">
                  {e.hypothesis}{' '}
                  <span
                    className={[
                      'font-mono text-[10px] font-normal uppercase',
                      e.confident ? 'text-live' : 'text-warn',
                    ].join(' ')}
                  >
                    {e.status}
                  </span>
                </p>
                <p className="text-sm text-dim">{e.conclusion}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Recommendations. */}
      {recommendations.length > 0 && (
        <section className="panel mt-6 p-5 sm:p-6">
          <span className="label">FullSend&rsquo;s recommendations</span>
          <ul className="mt-4 space-y-4">
            {recommendations.slice(0, 6).map((r) => (
              <li key={r.id} className="border-l-2 border-orange/50 pl-3.5">
                <p className="font-display text-sm font-bold leading-snug tracking-tight text-mist">
                  {r.statement}
                </p>
                <p className="mt-1 text-sm text-dim">{r.rationale}</p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-dimmer">
                  {r.status.replace('_', ' ')} · confidence {Math.round(r.confidence * 100)}%
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Weekly report. */}
      {report && (
        <section className="panel mt-6 p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <span className="label">The Weekly Send Report</span>
            <span className="font-mono text-[10px] text-dimmer">
              {report.week_start} → {report.week_end}
            </span>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Fact label="Posts" value={String(report.total_posts)} />
            <Fact label="Reach" value={formatCompact(report.reach)} />
            <Fact label="Engagement" value={formatCompact(report.engagement)} />
            <Fact label="Followers gained" value={formatCompact(report.followers_gained)} />
            <Fact label="Best format" value={report.best_format ?? '—'} />
            <Fact label="Best platform" value={report.best_platform ?? '—'} />
          </dl>
          {report.best_hook && (
            <p className="mt-4 border-l-2 border-live/50 pl-3 text-sm text-mist">
              Best hook: &ldquo;{report.best_hook}&rdquo;
            </p>
          )}
          <p className="mt-4 font-display text-base font-bold tracking-tight text-mist">
            {report.biggest_learning}
          </p>
          <p className="mt-2 text-sm text-dim">{report.next_week_strategy}</p>
        </section>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-charcoal px-4 py-5">
      <div className="label">{label}</div>
      <div className="stat mt-1.5 text-2xl text-mist">{value}</div>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="w-14 shrink-0 text-right">
      <div className="stat text-sm text-mist">{value}</div>
      <div className="font-mono text-[9px] text-dimmer">{label}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="stat mt-0.5 text-lg text-mist">{value}</dd>
    </div>
  );
}

function Breakdown({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; samples: number; mean_engagement: number; mean_reach: number }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.mean_engagement));
  return (
    <section className="panel p-5">
      <span className="label">{title}</span>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-dim">No data yet.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {[...rows]
            .sort((a, b) => b.mean_engagement - a.mean_engagement)
            .map((r) => (
              <li key={r.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-[11px] uppercase tracking-wider text-mist">
                    {String(r.key).replace('_', ' ')}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-dimmer">
                    {r.samples} post{r.samples === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-edge">
                    <span
                      className="block h-full bg-orange"
                      style={{ width: `${(r.mean_engagement / max) * 100}%` }}
                    />
                  </span>
                  <span className="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums text-dim">
                    {Math.round(r.mean_engagement)}
                  </span>
                </div>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
