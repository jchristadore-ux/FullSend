'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Project } from '@/lib/types';

const STORAGE_KEY = 'fullsend.activeProject';

/**
 * Which project the app is looking at. Kept in a cookie so server components
 * can read it, mirrored to localStorage so the choice survives a cold start.
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

  if (projects.length === 1) {
    const p = projects[0];
    return (
      <div className={compact ? 'text-right' : ''}>
        <div className="font-display text-sm font-extrabold tracking-tight text-mist">
          {p.name}
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-dimmer">
          {p.autopilot_mode.replace('_', ' ')}
        </div>
      </div>
    );
  }

  return (
    <select
      value={current}
      onChange={(e) => select(e.target.value)}
      aria-label="Active project"
      className={compact ? 'max-w-[45vw] !py-1.5 text-sm' : 'w-full text-sm'}
    >
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
