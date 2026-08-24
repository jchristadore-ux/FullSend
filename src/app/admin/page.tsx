import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/session';
import { systemScope } from '@/lib/db';
import { db } from '@/lib/db/repo';
import { queueStats } from '@/lib/jobs/runner';
import { aiSpend, getProvider } from '@/lib/ai/client';
import { cacheStats } from '@/lib/ai/cache';
import { platformStatus } from '@/lib/social/registry';
import { capabilities, env } from '@/lib/env';
import { formatCompact, relativeTime } from '@/lib/dashboard';
import { FullSendLockup } from '@/components/brand/Logo';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'FullSend Control Room' };

export default async function ControlRoom() {
  await requireAdmin();
  const scope = systemScope('control room');

  const [
    users,
    projects,
    accounts,
    queue,
    errors,
    runs,
    published,
    content,
    spend,
    subscriptions,
  ] = await Promise.all([
    db().find(scope, 'users', {}),
    db().find(scope, 'projects', { orderBy: 'created_at', direction: 'desc' }),
    db().find(scope, 'social_accounts', {}),
    queueStats(),
    db().find(scope, 'automation_errors', {
      where: { resolved: false },
      orderBy: 'created_at',
      direction: 'desc',
      limit: 20,
    }),
    db().find(scope, 'automation_runs', { orderBy: 'started_at', direction: 'desc', limit: 10 }),
    db().find(scope, 'published_posts', {}),
    db().find(scope, 'content_items', {}),
    aiSpend(scope, {}),
    db().find(scope, 'subscriptions', {}),
  ]);

  const caps = capabilities();
  const provider = getProvider();
  const platforms = platformStatus().filter((p) => p.live);
  const activeProjects = projects.filter((p) => p.status === 'live' || p.status === 'content_ready');
  const connected = accounts.filter((a) => a.status === 'connected');
  const needsAttention = accounts.filter((a) => a.status !== 'connected' && a.status !== 'disconnected');

  const costPerUser = users.length ? spend.total / users.length : 0;
  const costPerPost = content.length ? spend.total / content.length : 0;
  // Rough monthly infra estimate for the documented stack at this volume.
  const infraEstimate = estimateInfra(projects.length, published.length);

  return (
    <div className="min-h-screen bg-void">
      <header className="border-b border-edge bg-ink">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <div className="flex items-center gap-4">
            <FullSendLockup width={128} />
            <span className="label text-orange">CONTROL ROOM</span>
          </div>
          <Link href="/app" className="btn-quiet text-sm">
            ← Back to the app
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-5 py-8 sm:px-8">
        {/* Platform health. */}
        <section className="grid grid-cols-2 gap-px overflow-hidden border border-edge bg-edge sm:grid-cols-4 lg:grid-cols-7">
          <Stat label="Users" value={String(users.length)} />
          <Stat label="Projects" value={String(projects.length)} />
          <Stat label="Active" value={String(activeProjects.length)} />
          <Stat label="Accounts" value={String(connected.length)} />
          <Stat label="Content" value={formatCompact(content.length)} />
          <Stat label="Published" value={formatCompact(published.length)} />
          <Stat
            label="Failures"
            value={String(errors.length)}
            tone={errors.length ? 'bad' : 'good'}
          />
        </section>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {/* Jobs. */}
          <section className="panel p-5">
            <span className="label">Job queue</span>
            <div className="mt-3 grid grid-cols-5 gap-3">
              <Mini label="Queued" value={queue.queued} tone={queue.queued > 50 ? 'warn' : undefined} />
              <Mini label="Running" value={queue.running} />
              <Mini label="Done" value={queue.succeeded} />
              <Mini label="Failed" value={queue.failed} tone={queue.failed ? 'warn' : undefined} />
              <Mini label="Dead" value={queue.dead} tone={queue.dead ? 'bad' : undefined} />
            </div>
            {queue.oldestQueuedAt && (
              <p className="mt-3 font-mono text-[10px] text-dimmer">
                Oldest queued job: {relativeTime(queue.oldestQueuedAt)}
              </p>
            )}
            <p className="mt-3 border-t border-edge pt-3 font-mono text-[10px] leading-relaxed text-dimmer">
              Driven by /api/cron/* — queue every minute, publish every 5, daily and weekly loops.
              {!env.jobs.cronSecret && (
                <span className="block text-fail">
                  CRON_SECRET is not set — cron endpoints refuse every request.
                </span>
              )}
            </p>
          </section>

          {/* AI cost. */}
          <section className="panel p-5">
            <span className="label">AI usage & cost</span>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <Mini label="Total" value={`$${spend.total.toFixed(4)}`} />
              <Mini label="Calls" value={spend.calls} />
              <Mini label="Cache hits" value={spend.cacheHits} />
            </div>
            <dl className="mt-4 space-y-1.5 border-t border-edge pt-3 font-mono text-[11px]">
              <Row label="Per customer">${costPerUser.toFixed(4)}</Row>
              <Row label="Per post">${costPerPost.toFixed(5)}</Row>
              <Row label="Provider">
                {provider.name}
                {!provider.live && <span className="text-warn"> (deterministic)</span>}
              </Row>
              <Row label="Monthly budget">${env.ai.monthlyBudgetUsd}</Row>
              <Row label="Response cache">{cacheStats().entries} entries</Row>
              <Row label="Est. infra / month">${infraEstimate}</Row>
            </dl>
            {Object.keys(spend.byTask).length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-edge pt-3">
                {Object.entries(spend.byTask)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 6)
                  .map(([task, cost]) => (
                    <li key={task} className="flex justify-between font-mono text-[10px]">
                      <span className="text-dimmer">{task}</span>
                      <span className="tabular-nums text-mist">${cost.toFixed(5)}</span>
                    </li>
                  ))}
              </ul>
            )}
          </section>
        </div>

        {/* Platform status. */}
        <section className="panel mt-6 p-5">
          <span className="label">Platform health</span>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {platforms.map((p) => (
              <div key={p.platform} className="border border-edge bg-charcoal-raised p-4">
                <div className="flex items-center justify-between">
                  <span className="font-display text-sm font-extrabold tracking-tight text-mist">
                    {p.platform}
                  </span>
                  <span
                    className={[
                      'font-mono text-[10px] uppercase tracking-wider',
                      p.fullyOperational ? 'text-live' : p.configured ? 'text-warn' : 'text-dimmer',
                    ].join(' ')}
                  >
                    {p.fullyOperational ? 'operational' : p.configured ? 'restricted' : 'not configured'}
                  </span>
                </div>
                <p className="mt-1.5 font-mono text-[10px] text-dimmer">
                  {accounts.filter((a) => a.platform === p.platform && a.status === 'connected').length}{' '}
                  connected ·{' '}
                  {published.filter((x) => x.platform === p.platform).length} published
                </p>
                {p.restrictions.length > 0 && (
                  <p className="mt-2 text-[11px] leading-relaxed text-warn">{p.restrictions[0]}</p>
                )}
              </div>
            ))}
          </div>

          {needsAttention.length > 0 && (
            <ul className="mt-4 space-y-1.5 border-t border-edge pt-3">
              {needsAttention.map((a) => (
                <li key={a.id} className="flex justify-between gap-3 font-mono text-[11px]">
                  <span className="text-fail">
                    {a.platform} @{a.username} — {a.status}
                  </span>
                  <span className="truncate text-dimmer">{a.status_detail}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Deployment capabilities. */}
        <section className="panel mt-6 p-5">
          <span className="label">Deployment</span>
          <div className="mt-3 grid gap-x-8 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(caps).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between gap-3 font-mono text-[11px]">
                <span className="text-dimmer">{key}</span>
                <span
                  className={
                    value === true ? 'text-live' : value === false ? 'text-warn' : 'text-mist'
                  }
                >
                  {String(value)}
                </span>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {/* Failures. */}
          <section className="panel p-5">
            <span className="label">Unresolved failures</span>
            {errors.length === 0 ? (
              <p className="mt-3 text-sm text-live">Nothing failing.</p>
            ) : (
              <ul className="mt-3 space-y-2.5">
                {errors.map((e) => (
                  <li key={e.id} className="border-l-2 border-fail pl-3">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-fail">
                      {e.scope} · {relativeTime(e.created_at)}
                      {e.fatal && ' · FATAL'}
                    </p>
                    <p className="text-sm text-mist">{e.message}</p>
                    {e.remedy && <p className="text-sm text-dim">{e.remedy}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Automation runs. */}
          <section className="panel p-5">
            <span className="label">Recent automation runs</span>
            {runs.length === 0 ? (
              <p className="mt-3 text-sm text-dim">No runs yet.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {runs.map((r) => (
                  <li key={r.id} className="border-b border-edge pb-2 last:border-b-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-[11px] text-mist">
                        {r.kind} · {relativeTime(r.started_at)}
                      </span>
                      <span
                        className={[
                          'font-mono text-[10px] uppercase',
                          r.status === 'succeeded'
                            ? 'text-live'
                            : r.status === 'partial'
                              ? 'text-warn'
                              : r.status === 'failed'
                                ? 'text-fail'
                                : 'text-dim',
                        ].join(' ')}
                      >
                        {r.status}
                      </span>
                    </div>
                    {r.summary && <p className="text-[11px] text-dim">{r.summary}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Projects. */}
        <section className="panel mt-6 overflow-hidden">
          <div className="border-b border-edge p-5">
            <span className="label">Projects</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-edge font-mono text-[10px] uppercase tracking-wider text-dimmer">
                  <th className="px-5 py-2.5 font-normal">Project</th>
                  <th className="px-5 py-2.5 font-normal">Status</th>
                  <th className="px-5 py-2.5 font-normal">Mode</th>
                  <th className="px-5 py-2.5 font-normal">Content</th>
                  <th className="px-5 py-2.5 font-normal">Published</th>
                  <th className="px-5 py-2.5 font-normal">Accounts</th>
                  <th className="px-5 py-2.5 font-normal">Last run</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id} className="border-b border-edge last:border-b-0">
                    <td className="px-5 py-2.5">
                      <span className="font-semibold text-mist">{p.name}</span>
                      {p.is_internal && (
                        <span className="ml-2 font-mono text-[9px] uppercase text-orange">
                          internal
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 font-mono text-[11px] text-dim">{p.status}</td>
                    <td className="px-5 py-2.5 font-mono text-[11px] text-dim">
                      {p.autopilot_mode.replace('_', ' ')}
                    </td>
                    <td className="px-5 py-2.5 tabular-nums text-dim">
                      {content.filter((c) => c.project_id === p.id).length}
                    </td>
                    <td className="px-5 py-2.5 tabular-nums text-dim">
                      {published.filter((x) => x.project_id === p.id).length}
                    </td>
                    <td className="px-5 py-2.5 tabular-nums text-dim">
                      {accounts.filter((a) => a.project_id === p.id && a.status === 'connected').length}
                    </td>
                    <td className="px-5 py-2.5 font-mono text-[11px] text-dimmer">
                      {p.last_autopilot_run_at ? relativeTime(p.last_autopilot_run_at) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <p className="mt-6 font-mono text-[10px] text-dimmer">
          {subscriptions.length} subscription record(s) · billing{' '}
          {env.stripe.enabled ? 'enabled' : 'disabled'}
        </p>
      </main>
    </div>
  );
}

/** Rough monthly infrastructure cost for the documented stack. */
function estimateInfra(projects: number, posts: number): string {
  // Vercel Hobby/Pro + Supabase free/pro, stepping up with real usage.
  const vercel = projects > 3 ? 20 : 0;
  const supabase = projects > 2 || posts > 500 ? 25 : 0;
  return (vercel + supabase).toFixed(2);
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="bg-charcoal px-4 py-5">
      <div className="label">{label}</div>
      <div
        className={[
          'stat mt-1.5 text-2xl',
          tone === 'bad' ? 'text-fail' : tone === 'good' ? 'text-live' : 'text-mist',
        ].join(' ')}
      >
        {value}
      </div>
    </div>
  );
}

function Mini({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'warn' | 'bad';
}) {
  return (
    <div>
      <div className="label">{label}</div>
      <div
        className={[
          'stat mt-0.5 text-lg',
          tone === 'bad' ? 'text-fail' : tone === 'warn' ? 'text-warn' : 'text-mist',
        ].join(' ')}
      >
        {value}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-dimmer">{label}</dt>
      <dd className="text-mist">{children}</dd>
    </div>
  );
}
