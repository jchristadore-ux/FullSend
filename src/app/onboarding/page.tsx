import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { listProjects } from '@/lib/db/repo';
import { FullSendLockup } from '@/components/brand/Logo';
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow';
import { capabilities } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'What’s your app?' };

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect('/login?next=/onboarding');

  const projects = await listProjects(session.scope, session.user.id);
  const caps = capabilities();

  return (
    <main className="relative min-h-screen bg-void">
      <div className="absolute inset-0 grid-backdrop" />
      <div className="absolute inset-0 orange-bloom" />

      <header className="relative border-b border-edge">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-4 sm:px-8">
          <Link href="/">
            <FullSendLockup width={140} />
          </Link>
          {projects.length > 0 && (
            <Link href="/app" className="btn-quiet text-sm">
              Back to the Send Center →
            </Link>
          )}
        </div>
      </header>

      <div className="relative mx-auto max-w-3xl px-5 py-14 sm:px-8 sm:py-20">
        <OnboardingFlow capabilities={caps} />
      </div>
    </main>
  );
}
