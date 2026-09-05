import Link from 'next/link';
import { FullSendLockup } from '@/components/brand/Logo';

export default function NotFound() {
  return (
    <main className="relative flex min-h-screen items-center justify-center bg-void px-5">
      <div className="absolute inset-0 grid-backdrop" />
      <div className="absolute inset-0 orange-bloom" />

      <div className="relative w-full max-w-md text-center">
        <Link href="/" className="inline-block">
          <FullSendLockup width={160} />
        </Link>

        <p className="label mt-10 text-orange">404</p>
        <h1 className="mt-3 font-display text-4xl font-extrabold tracking-crush text-mist">
          Nothing here.
        </h1>
        <p className="mt-3 text-dim">
          That page does not exist — or it moved. Head back and keep sending.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href="/app" className="btn-primary">
            Send Center →
          </Link>
          <Link href="/" className="btn-quiet">
            Home
          </Link>
        </div>
      </div>
    </main>
  );
}
