import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { listProjects } from '@/lib/db/repo';
import { FullSendIcon, FullSendLockup } from '@/components/brand/Logo';
import { AppNav } from '@/components/app/AppNav';
import { ProjectSwitcher } from '@/components/app/ProjectSwitcher';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    const pathname = (await headers()).get('x-pathname') ?? '/app';
    redirect('/login?next=' + encodeURIComponent(pathname));
  }

  const projects = await listProjects(session.scope, session.user.id);
  if (projects.length === 0) redirect('/onboarding');

  return (
    <div className="min-h-screen bg-void">
      {/* Desktop: a fixed rail. Mobile: a bottom bar, handled in AppNav. */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-edge bg-ink lg:flex">
        <div className="border-b border-edge px-5 py-5">
          <Link href="/app">
            <FullSendLockup width={128} />
          </Link>
        </div>
        <div className="border-b border-edge px-4 py-4">
          <ProjectSwitcher projects={projects} />
        </div>
        <AppNav variant="rail" />
        <div className="mt-auto border-t border-edge px-5 py-4">
          <p className="font-mono text-[10px] leading-relaxed text-dimmer">
            {session.user.email}
          </p>
          {session.user.is_admin && (
            <Link
              href="/admin"
              className="mt-2 block font-mono text-[10px] text-orange hover:text-orange-bright"
            >
              CONTROL ROOM →
            </Link>
          )}
        </div>
      </aside>

      {/* Mobile top bar. */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-edge bg-void/95 px-4 py-3 backdrop-blur lg:hidden">
        <Link href="/app" className="flex items-center gap-2.5">
          <FullSendIcon size={22} />
          <span className="font-display text-base font-extrabold tracking-tight text-mist">
            FullSend
          </span>
        </Link>
        <ProjectSwitcher projects={projects} compact />
      </header>

      <main className="pb-24 lg:ml-60 lg:pb-0">{children}</main>

      <AppNav variant="bottom" />
    </div>
  );
}
