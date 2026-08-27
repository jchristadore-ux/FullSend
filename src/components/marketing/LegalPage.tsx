import Link from 'next/link';
import { FullSendLockup } from '@/components/brand/Logo';
import { legalContact } from '@/lib/legal-contact';

/**
 * The shell every legal page shares.
 *
 * These pages exist because TikTok and Meta both refuse to review an app
 * without a reachable Terms of Service and Privacy Policy URL. They are read
 * by a human reviewer, so they are plain, specific, and describe what this
 * codebase actually does rather than what a generic template assumes.
 */
export function LegalPage({
  title,
  updated,
  intro,
  children,
}: {
  title: string;
  updated: string;
  intro: string;
  children: React.ReactNode;
}) {
  const contact = legalContact();

  return (
    <main className="min-h-screen bg-void">
      <header className="border-b border-edge/60">
        <nav className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4 sm:px-8">
          <Link href="/" className="flex items-center">
            <FullSendLockup width={132} />
          </Link>
          <div className="flex gap-5 font-mono text-xs text-dimmer">
            <Link href="/terms" className="transition-colors hover:text-mist">
              Terms
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-mist">
              Privacy
            </Link>
            <Link href="/data-deletion" className="transition-colors hover:text-mist">
              Delete data
            </Link>
          </div>
        </nav>
      </header>

      <article className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
        <p className="label">Last updated {updated}</p>
        <h1 className="mt-3 font-display text-4xl font-extrabold tracking-tight text-mist sm:text-5xl">
          {title}
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-dim">{intro}</p>

        {!contact && (
          <div className="mt-8 border-l-2 border-fail bg-fail/5 p-4">
            <p className="font-display text-sm font-bold text-mist">
              This page is not ready to be submitted for platform review.
            </p>
            <p className="mt-1 text-sm text-dim">
              A privacy policy has to name someone a person can actually contact. Set{' '}
              <code className="font-mono text-xs text-orange">FULLSEND_CONTACT_EMAIL</code> in your
              hosting environment and redeploy — every &ldquo;contact us&rdquo; below fills itself
              in. TikTok and Meta reviewers both check for this.
            </p>
          </div>
        )}

        <div className="mt-10 space-y-10">{children}</div>

        <footer className="mt-16 border-t border-edge pt-8">
          <p className="font-mono text-xs text-dimmer">FullSend. Everything goes live.</p>
        </footer>
      </article>
    </main>
  );
}

/** One numbered section. */
export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-xl font-extrabold tracking-tight text-mist">{heading}</h2>
      <div className="mt-3 space-y-3 leading-relaxed text-dim [&_a]:text-orange [&_a:hover]:underline [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-mist [&_strong]:text-mist">
        {children}
      </div>
    </section>
  );
}

/** A bulleted list with the spacing the rest of the page uses. */
export function Points({ children }: { children: React.ReactNode }) {
  return (
    <ul className="ml-5 list-disc space-y-2 marker:text-dimmer [&_strong]:text-mist">{children}</ul>
  );
}

/**
 * A table that scrolls on its own rather than pushing the page sideways.
 */
export function DataTable({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-edge">
            {head.map((h) => (
              <th key={h} className="label pb-2 pr-4 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-edge/50 align-top">
              {row.map((cell, j) => (
                <td key={j} className="py-3 pr-4 text-dim [&_code]:font-mono [&_code]:text-xs">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The contact line, or an honest note that the operator has not set one. */
export function ContactLine() {
  const contact = legalContact();
  if (!contact) {
    return (
      <p className="text-fail">
        No contact address is configured for this deployment. Set{' '}
        <code className="font-mono text-xs">FULLSEND_CONTACT_EMAIL</code> and redeploy.
      </p>
    );
  }
  return (
    <p>
      Email{' '}
      <a href={`mailto:${contact}`} className="text-orange hover:underline">
        {contact}
      </a>
      .
    </p>
  );
}
