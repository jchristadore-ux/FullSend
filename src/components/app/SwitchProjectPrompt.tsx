'use client';

import { useRouter } from 'next/navigation';

/**
 * "Your other app has work in it — switch to it."
 *
 * Shown when the project the app is pointed at has no analysis and another one
 * does. Writes the same cookie the switcher writes, so the choice sticks.
 */
export function SwitchProjectPrompt({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const router = useRouter();

  function switchTo() {
    try {
      localStorage.setItem('fullsend.activeProject', projectId);
    } catch {
      /* private mode — the cookie below is what the server reads */
    }
    document.cookie = `fs_project=${projectId}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    router.refresh();
  }

  return (
    <button
      onClick={switchTo}
      className="mt-6 flex w-full items-center justify-between gap-4 border border-orange/40 bg-orange/10 px-5 py-4 text-left transition-colors hover:bg-orange/15"
    >
      <span>
        <span className="block font-display text-sm font-bold tracking-tight text-mist">
          Switch to {projectName}
        </span>
        <span className="mt-0.5 block font-mono text-[11px] text-dimmer">
          This app has no analysis yet — {projectName} is the one FullSend has already
          analysed, written content for and scheduled.
        </span>
      </span>
      <span className="shrink-0 font-display text-sm font-extrabold text-orange">→</span>
    </button>
  );
}
