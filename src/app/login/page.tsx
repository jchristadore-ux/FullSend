import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FullSendLockup } from '@/components/brand/Logo';
import { devAuthAvailable, getSession, supabaseConfigured } from '@/lib/auth/session';
import { LoginForm } from '@/components/auth/LoginForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const session = await getSession();
  const params = await searchParams;
  if (session) redirect(params.next ?? '/app');

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-void px-5">
      <div className="absolute inset-0 grid-backdrop" />
      <div className="absolute inset-0 orange-bloom" />

      <div className="relative w-full max-w-md">
        <Link href="/" className="block">
          <FullSendLockup width={160} />
        </Link>

        <h1 className="mt-8 font-display text-4xl font-extrabold tracking-crush text-mist">
          Sign in.
        </h1>
        <p className="mt-2 text-dim">Everything goes live from here.</p>

        <div className="panel mt-8 p-6">
          <LoginForm
            mode={supabaseConfigured() ? 'supabase' : devAuthAvailable() ? 'dev' : 'unavailable'}
            next={params.next ?? '/app'}
            initialError={params.error ?? null}
          />
        </div>

        <p className="mt-6 text-center font-mono text-[11px] text-dimmer">
          New here?{' '}
          <Link href="/login?next=/onboarding" className="text-orange hover:underline">
            Sign in, then paste a repo →
          </Link>
        </p>
      </div>
    </main>
  );
}
