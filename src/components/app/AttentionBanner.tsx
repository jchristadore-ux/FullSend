import Link from 'next/link';
import { platformLabel } from '@/lib/platform-labels';

/**
 * The "INSTAGRAM NEEDS ATTENTION" banner. Says what broke, what it stopped,
 * and gives one button that fixes it.
 */
export function AttentionBanner({
  items,
}: {
  items: { platform: string; message: string; remedy: string | null }[];
}) {
  return (
    <div className="mt-6 space-y-3">
      {items.map((item, i) => {
        const isPlatform = ['instagram', 'tiktok'].includes(item.platform);
        return (
          <div
            key={`${item.platform}-${i}`}
            className="border border-fail/50 bg-fail/10 px-5 py-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-display text-sm font-extrabold uppercase tracking-tight text-fail">
                  {isPlatform ? `${platformLabel(item.platform)} needs attention` : 'Something needs attention'}
                </p>
                <p className="mt-1 text-sm text-mist">{item.message}</p>
                {item.remedy && <p className="mt-1 text-sm text-dim">{item.remedy}</p>}
              </div>
              {isPlatform && (
                <Link
                  href={`/app/accounts?reconnect=${item.platform}`}
                  className="btn-send shrink-0 !px-4 !py-2.5 text-xs"
                >
                  RECONNECT {platformLabel(item.platform).toUpperCase()}
                </Link>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
