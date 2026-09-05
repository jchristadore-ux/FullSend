import Link from 'next/link';
import { FullSendLockup } from '@/components/brand/Logo';

export default function NotFound() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-void px-5">
      <div className="absolute inset-0 grid-backdrop" />
      <div className="absolute inset-0 orange-bloom" />

      <div className="relative max-w-lg text-center">
        <Link href="/" className="inline-flex justify-center">
          <FullSendLockup width={148} />
        </Link>

        <p className="mt-10 font-mono text-xs tracking-widest text-orange">404</p>
        <h1 className="mt-3 font-display text-4xl font-extrabold tracking-crush text-mist sm:text-5xl">
          Nothing here.
        </h1>
        <p className="mt-4 text-base leading-relaxed text-dim">
          This page never made it to production. The void stays empty on purpose.
        </p>

        <Link href="/" className="btn-send mt-10 inline-flex text-base">
          HOME →
        </Link>
        <p className="mt-6 font-mono text-xs text-dimmer">BUILD ONCE. MARKET FOREVER.</p>
      </div>
    </main>
  );
}
