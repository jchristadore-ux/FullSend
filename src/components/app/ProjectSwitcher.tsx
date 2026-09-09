'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Project } from '@/lib/types';

const STORAGE_KEY = 'fullsend.activeProject';

/** Start another app from Send Center; plan limits still enforce on create. */
const ADD_APP_HREF = '/onboarding?next=/app';

/**
 * Which project the app is looking at. Kept in a cookie so server components
 * can read it, mirrored to localStorage so the choice survives a cold start.
 *
 * Always shows an Add app control so founders are not stuck switching only
 * among existing projects after magic-link login.
 */
export function ProjectSwitcher({
  projects,
  compact = false,
}: {
  projects: Project[];
  compact?: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<string>(projects[0]?.id ?? '');

  useEffect(() => {
    const fromCookie = document.cookie
      .split('; ')
      .find((c) => c.startsWith('fs_project='))
      ?.split('=')[1];
    const stored = fromCookie ?? localStorage.getItem(STORAGE_KEY) ?? '';
    if (stored && projects.some((p) => p.id === stored)) setCurrent(stored);
  }, [projects]);

  function select(id: string) {
    setCurrent(id);
    localStorage.setItem(STORAGE_KEY, id);
    document.cookie = `fs_project=${id}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    router.refresh();
  }

  const addApp = (
    <Link
      href={ADD_APP_HREF}
      className={[
        'font-mono text-[10px] uppercase tracking-widest text-orange hover:text-orange-bright',
        compact ? 'shrink-0 whitespace-nowrap' : 'mt-2 inline-block',
      ].join(' ')}
      aria-label="Add app"
    >
      {compact ? '+ App' : '+ Add app'}
    </Link>
  );

  if (projects.length === 1) {
    const p = projects[0];
    return (
      <div
        className={
          compact
            ? 'flex max-w-[70vw] items-center justify-end gap-3 text-right'
            : ''
        }
      >
        <div className={compact ? 'min-w-0' : ''}>
          <div className="truncate font-display text-sm font-extrabold tracking-tight text-mist">
            {p.name}
          </div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-dimmer">
            {p.autopilot_mode.replace('_', ' ')}
          </div>
        </div>
        {addApp}
      </div>
    );
  }

  return (
    <div className={compact ? 'flex max-w-[70vw] items-center gap-2' : ''}>
      <select
        value={current}
        onChange={(e) => select(e.target.value)}
        aria-label="Active project"
        className={compact ? 'min-w-0 flex-1 !py-1.5 text-sm' : 'w-full text-sm'}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {addApp}
    </div>
  );
}