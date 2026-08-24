import Link from 'next/link';
import { formatCompact, formatSendTime, relativeTime } from '@/lib/dashboard';
import type { SendCenterData } from '@/lib/dashboard';

/**
 * The phone view.
 *
 * A founder opening FullSend on their phone wants four facts, not a dashboard:
 * is it live, what goes out next, how much is queued, and how the week went.
 * Everything else is one tap away.
 */
export function MobileSummary({ data }: { data: SendCenterData }) {
  const best = data.whatsWorking[0] ?? null;

  return (
    <div className="lg:hidden">
      <div className="panel mt-6 divide-y divide-edge">
        <Row
          label="Status"
          value={
            <span className={data.autopilotOn ? 'text-live' : 'text-warn'}>
              {data.autopilotOn ? 'FULLSEND IS LIVE 🟢' : 'PAUSED'}
            </span>
          }
        />

        <Row
          label="Next post"
          value={
            data.nextSend
              ? formatSendTime(data.nextSend.scheduledPost.scheduled_for, data.project.timezone)
              : 'Nothing queued'
          }
        />

        <Row label="Queued" value={`${data.runway.queued} posts`} />

        <Row label="Reach (28d)" value={formatCompact(data.metrics.reach)} />

        {best && (
          <Row
            label="Best post"
            value={`${formatCompact(best.metrics.reach || best.metrics.views)} reach`}
            sub={best.content.hook}
          />
        )}
      </div>

      {data.nextSend && (
        <Link
          href={`/app/content/${data.nextSend.content.id}`}
          className="panel mt-4 flex items-center gap-3 p-4"
        >
          {data.nextSend.preview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.nextSend.preview}
              alt=""
              className="h-16 w-12 shrink-0 rounded-sm border border-edge object-cover"
            />
          )}
          <div className="min-w-0">
            <p className="label">Up next</p>
            <p className="mt-0.5 line-clamp-2 font-display text-base font-extrabold leading-snug tracking-tight text-mist">
              {data.nextSend.content.hook}
            </p>
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-dimmer">
              {data.nextSend.content.platform} ·{' '}
              {relativeTime(data.nextSend.scheduledPost.scheduled_for)}
            </p>
          </div>
        </Link>
      )}

      {data.nextMove && (
        <div className="panel mt-4 border-l-2 border-l-orange p-4">
          <p className="label">FullSend&rsquo;s next move</p>
          <p className="mt-1.5 font-display text-base font-bold leading-snug tracking-tight text-mist">
            {data.nextMove.statement}
          </p>
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <Link href="/app/calendar" className="btn-ghost flex-1 !px-3 !py-2.5 text-xs">
          CALENDAR
        </Link>
        <Link href="/app/content" className="btn-ghost flex-1 !px-3 !py-2.5 text-xs">
          CONTENT
        </Link>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3.5">
      <span className="label shrink-0 pt-0.5">{label}</span>
      <span className="min-w-0 text-right">
        <span className="block font-display text-base font-extrabold tracking-tight text-mist">
          {value}
        </span>
        {sub && <span className="mt-0.5 line-clamp-1 block text-xs text-dimmer">{sub}</span>}
      </span>
    </div>
  );
}
