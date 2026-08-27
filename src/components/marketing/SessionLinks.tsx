'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

/**
 * The landing page's way in, for whoever is actually looking at it.
 *
 * The page itself is static, so it renders the signed-out links first and
 * corrects itself once it knows. That order matters: the signed-out links are
 * never wrong — /login sends a signed-in visitor straight on to the Send
 * Center — so the first paint is always usable, and knowing only improves it.
 */
export function useSignedIn(): boolean | null {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/auth/session', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { signedIn: false }))
      .then((j: { signedIn?: unknown }) => {
        if (live) setSignedIn(j.signedIn === true);
      })
      .catch(() => {
        if (live) setSignedIn(false);
      });
    return () => {
      live = false;
    };
  }, []);

  return signedIn;
}

/** The quiet link in the header and footer. */
export function SignInLink({ className }: { className?: string }) {
  const signedIn = useSignedIn();
  return (
    <Link href={signedIn ? '/app' : '/login'} className={className}>
      {signedIn ? 'Send Center' : 'Sign in'}
    </Link>
  );
}

/**
 * The primary call to action.
 *
 * Signed out it starts the product. Signed in it goes to the Send Center
 * rather than /onboarding, which would have begun a second project — the
 * opposite of what someone returning to their dashboard wants.
 */
export function StartLink({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const signedIn = useSignedIn();
  return (
    <Link href={signedIn ? '/app' : '/onboarding'} className={className}>
      {signedIn ? 'SEND CENTER →' : (children ?? 'SEND IT →')}
    </Link>
  );
}
