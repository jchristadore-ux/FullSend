'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { Project } from '@/lib/types';

const STORAGE_KEY = 'fullsend.activeProject';
const COOKIE = 'fs_project';

/** Start another app from Send Center; plan limits still enforce on create. */
const ADD_APP_HREF = '/onboarding?next=/app';

function writeCookie(id: string) {
  document.cookie = `${COOKIE}=${id}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

function readCookie(): string {
  return (
    document.cookie
      .split('; ')
      .find((c) => c.startsWith(`${COOKIE}=`))
      ?.split('=')[1] ?? ''
  );
}

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    // Private mode, or storage blocked. The cookie is what the server reads.
    return '';
  }
}

function writeStored(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

/**
 * Which project the app is looking at.
 *
 * `activeId` is what the server actually rendered this page with, so it is the
 * value shown — the control used to show `projects[0]` while the page below it
 * rendered something else, which is how a founder read one project's name
 * above another project's empty dashboard.
 *
 * The choice is pinned in a cookie as soon as this mounts, including when
 * there is only one project. That matters because of the Add app button: with
 * no cookie written, adding a second app made the new, empty project the
 * default for the whole app and the founder's real one looked wiped.
 */
export function ProjectSwitcher({
  projects,
  activeId,
  compact = false,
}: {
  projects: Project[];
  activeId?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const resolved = projects.some((p) => p.id === activeId)
    ? (activeId as string)
    : (projects[0]?.id ?? '');

  /*
   * Only a selection made here lives in state, and only until the server
   * re-renders with it. Everything else is read from `resolved`, so this
   * control cannot drift out of step with the page it labels.
   */
  const [pending, setPending] = useState<string | null>(null);
  const current = pending && projects.some((p) => p.id === pending) ? pending : resolved;

  const select = useCallback(
    (id: string) => {
      setPending(id);
      writeStored(id);
      writeCookie(id);
      router.refresh();
    },
    [router],
  );

  useEffect(() => {
    if (!resolved) return;
    const cookie = readCookie();

    if (!cookie) {
      /*
       * Nothing recorded yet. Adopt a remembered choice if it is still a real
       * project — that is what survives a cold start — otherwise pin what the
       * server chose, so the app stops depending on an implicit default.
       */
      const stored = readStored();
      if (stored && stored !== resolved && projects.some((p) => p.id === stored)) {
        writeCookie(stored);
        router.refresh();
        return;
      }
      writeCookie(resolved);
      writeStored(resolved);
      return;
    }

    // A cookie naming a project that no longer exists (deleted, or another
    // account's) — the server already ignored it, so bring it back in line.
    if (!projects.some((p) => p.id === cookie)) {
      writeCookie(resolved);
      writeStored(resolved);
      return;
    }

    if (cookie !== resolved) writeStored(cookie);
    else writeStored(resolved);
  }, [projects, resolved, router]);

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
