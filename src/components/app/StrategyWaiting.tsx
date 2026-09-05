'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Analysis is done; strategy is still being written.
 *
 * Auto-refresh so the founder does not sit on a manual refresh loop, and a
 * clear path back to the Send Center where the pipeline shows the same work.
 */
export function StrategyWaiting() {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => {
      router.refresh();
    }, 4000);
    return () => clearInterval(id);
  }, [router]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-8">
      <span className="label">Marketing Strategy</span>
      <h1 className="mt-3 font-display text-3xl font-extrabold tracking-crush text-mist">
        Still building.
      </h1>
      <p className="mt-3 text-dim">
        The analysis is done — the strategy is still being generated. This page
        refreshes on its own when it lands.
      </p>
      <p className="mt-6">
        <Link href="/app" className="btn-send !px-4 !py-2 text-xs">
          OPEN SEND CENTER →
        </Link>
      </p>
      <p className="mt-4 font-mono text-[11px] text-dimmer">
        The pipeline on the Send Center shows the same stage if you want to watch it there.
      </p>
    </div>
  );
}
