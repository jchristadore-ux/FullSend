import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { activeProject } from '@/lib/active-project';
import { formatCompact, formatSendTime, loadSendCenter, relativeTime } from '@/lib/dashboard';
import { scoreVerdict } from '@/lib/analytics/send-score';
import { NextMoveCard } from '@/components/app/NextMoveCard';
import { AttentionBanner } from '@/components/app/AttentionBanner';
import { MobileSummary } from '@/components/app/MobileSummary';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'The Send Center' };

export default async function SendCenter() {
  const session = await requireSession();
  const project = await activeProject(session);
  if (!project) redirect('/onboarding');

  const data = await loadSendCenter(session.scope, project);
  const verdict = scoreVerdict(data.sendScore.total);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-10">
      {/* Status line. */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className={data.autopilotOn ? 'dot-live' : 'inline-block h-2 w-2 rounded-full bg-warn'} />
          <span className="font-display text-sm font-extrabold tracking-tight text-mist">
            {data.autopilotOn ? 'AUTOPILOT ACTIVE' : 'AUTOPILOT PAUSED'}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-widest text-dimmer">
            {project.autopilot_mode.replace('_', ' ')}
          </span>
        </div>
        <Link href="/app/settings" className="btn-quiet">
          Change mode
        </Link>
      </div>

      {/* Hero metric. */}
      <h1 className="mt-5 font-display text-4xl font-extrabold leading-[0.95] tracking-crush text-mist sm:text-6xl">
        {data.autopilotOn ? (
          <>
            Your marketing
            <br />
            is running.
          </>
        ) : (
          <>
            Your marketing
            <br />
            <span className="text-warn">is on hold.</span>
          </>
        )}
      </h1>

      {data.attention.length > 0 && <AttentionBanner items={data.attention} />}

      {!data.hasAnalysis && <SetupPrompt href="/onboarding" label="Analyze your repository" />}
      {data.hasAnalysis && !data.strategyApproved && (
        <SetupPrompt href="/app/strategy" label="Approve your strategy to start sending" />
      )}
      {data.strategyApproved && data.accounts.length === 0 && (
        <SetupPrompt href="/app/accounts" label="Connect Instagram or TikTok to publish" />
      )}

      {/* On a phone, four facts and a tap. The full command centre is desktop. */}
      <MobileSummary data={data} />

      {/* Metrics. */}
      <section className="mt-8 hidden grid-cols-2 gap-px overflow-hidden border border-edge bg-edge sm:grid-cols-3 lg:grid lg:grid-cols-6">
        <Metric label="Scheduled" value={formatCompact(data.metrics.postsScheduled)} />
        <Metric label="Published" value={formatCompact(data.metrics.postsPublished)} />
        <Metric label="Reach" value={formatCompact(data.metrics.reach)} />
        <Metric label="Engagement" value={formatCompact(data.metrics.engagement)} />
        <Metric label="Clicks" value={formatCompact(data.metrics.clicks)} />
        <Metric label="Conversions" value={formatCompact(data.metrics.conversions)} />
      </section>

      <div className="mt-6 hidden gap-6 lg:grid lg:grid-cols-[1.15fr_1fr]">
        <div className="space-y-6">
          {/* NEXT SEND */}
          <section className="panel p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <span className="label">Next send</span>
              <Link href="/app/calendar" className="btn-quiet text-xs">
                Calendar →
              </Link>
            </div>

            {data.nextSend ? (
              <div className="mt-4 flex gap-4">
                {data.nextSend.preview && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={data.nextSend.preview}
                    alt=""
                    className="h-28 w-[84px] shrink-0 rounded-sm border border-edge object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-display text-lg font-extrabold leading-tight tracking-tight text-mist">
                    {data.nextSend.content.hook}
                  </p>
                  <p className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[11px] text-dimmer">
                    <Tag>{data.nextSend.content.platform}</Tag>
                    <Tag>{data.nextSend.content.format}</Tag>
                    <span className="text-orange">
                      {formatSendTime(data.nextSend.scheduledPost.scheduled_for, project.timezone)}
                    </span>
                  </p>
                  <p className="mt-3 line-clamp-2 text-sm text-dim">
                    {data.nextSend.content.caption}
                  </p>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-sm text-dim">
                Nothing queued yet.{' '}
                <Link href="/app/content" className="text-orange hover:underline">
                  Generate content →
                </Link>
              </p>
            )}

            <p className="mt-5 border-t border-edge pt-4 font-mono text-[11px] text-dimmer">
              {data.runway.queued} queued · {data.runway.daysOfRunway} days of runway
            </p>
          </section>

          {/* RECENT SENDS */}
          <section className="panel p-5 sm:p-6">
            <span className="label">Recent sends</span>
            {data.recentSends.length === 0 ? (
              <p className="mt-4 text-sm text-dim">Nothing published yet.</p>
            ) : (
              <ul className="mt-4 space-y-0">
                {data.recentSends.map((post) => (
                  <li
                    key={post.id}
                    className="flex items-center gap-3 border-b border-edge py-3 last:border-b-0"
                  >
                    {post.preview && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={post.preview}
                        alt=""
                        className="h-11 w-9 shrink-0 rounded-sm border border-edge object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-mist">{post.hook}</p>
                      <p className="font-mono text-[10px] text-dimmer">
                        {post.platform} · {relativeTime(post.publishedAt)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="stat text-sm text-mist">{formatCompact(post.reach)}</div>
                      <div className="font-mono text-[10px] text-dimmer">reach</div>
                    </div>
                    {post.permalink && (
                      <a
                        href={post.permalink}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="shrink-0 font-mono text-xs text-dimmer transition-colors hover:text-orange"
                        aria-label="Open post"
                      >
                        ↗
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="space-y-6">
          {/* SEND SCORE */}
          <section className="panel p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <span className="label">The Send Score</span>
              <Link href="/app/analytics" className="btn-quiet text-xs">
                Breakdown →
              </Link>
            </div>
            <div className="mt-3 flex items-baseline gap-3">
              <span className="stat text-6xl text-orange">{data.sendScore.total}</span>
              <span className="font-display text-lg font-bold text-dimmer">/ 100</span>
            </div>
            <p
              className={[
                'mt-1 font-display text-sm font-bold tracking-tight',
                verdict.tone === 'good'
                  ? 'text-live'
                  : verdict.tone === 'ok'
                    ? 'text-warn'
                    : 'text-dim',
              ].join(' ')}
            >
              {verdict.label}
            </p>

            <div className="mt-5 space-y-2.5">
              {(
                [
                  ['Content', data.sendScore.content],
                  ['Audience', data.sendScore.audience],
                  ['Engagement', data.sendScore.engagement],
                  ['Consistency', data.sendScore.consistency],
                  ['Conversion', data.sendScore.conversion],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex items-center gap-3">
                  <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-wider text-dimmer">
                    {label}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-edge">
                    <span
                      className="block h-full bg-orange transition-all duration-700"
                      style={{ width: `${value}%` }}
                    />
                  </span>
                  <span className="w-7 shrink-0 text-right font-mono text-[11px] tabular-nums text-mist">
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* WHAT'S WORKING */}
          <section className="panel p-5 sm:p-6">
            <span className="label">What&rsquo;s working</span>
            {data.whatsWorking.length === 0 ? (
              <p className="mt-4 text-sm text-dim">
                Not enough published posts to call a winner yet.
              </p>
            ) : (
              <ol className="mt-4 space-y-3">
                {data.whatsWorking.map((p, i) => (
                  <li key={p.publishedPost.id} className="flex gap-3">
                    <span className="stat shrink-0 text-lg text-orange">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <div className="min-w-0">
                      <p className="line-clamp-2 text-sm font-semibold leading-snug text-mist">
                        {p.content.hook}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] text-dimmer">
                        {p.content.format} · {formatCompact(p.engagement)} engagements ·{' '}
                        {(p.engagementRate * 100).toFixed(1)}% rate
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* FULLSEND'S NEXT MOVE */}
          <NextMoveCard projectId={project.id} recommendation={data.nextMove} />
        </div>
      </div>

      {data.weeklyReport && (
        <section className="panel mt-6 hidden p-5 sm:p-6 lg:block">
          <div className="flex items-center justify-between">
            <span className="label">Latest Weekly Send Report</span>
            <span className="font-mono text-[10px] text-dimmer">
              {data.weeklyReport.week_start} → {data.weeklyReport.week_end}
            </span>
          </div>
          <p className="mt-3 font-display text-lg font-bold tracking-tight text-mist">
            {data.weeklyReport.biggest_learning}
          </p>
          <p className="mt-2 text-sm text-dim">{data.weeklyReport.next_week_strategy}</p>
        </section>
      )}

      <p className="mt-8 hidden text-center font-mono text-[10px] text-dimmer lg:block">
        AI spend on this project: ${data.aiCostUsd.toFixed(4)}
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-charcoal px-4 py-5">
      <div className="label">{label}</div>
      <div className="stat mt-1.5 text-2xl text-mist sm:text-3xl">{value}</div>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="border border-edge bg-charcoal px-1.5 py-0.5 uppercase tracking-wider">
      {children}
    </span>
  );
}

function SetupPrompt({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="mt-6 flex items-center justify-between gap-4 border border-orange/40 bg-orange/10 px-5 py-4 transition-colors hover:bg-orange/15"
    >
      <span className="font-display text-sm font-bold tracking-tight text-mist">{label}</span>
      <span className="font-display text-sm font-extrabold text-orange">→</span>
    </Link>
  );
}
