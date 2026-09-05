import { redirect } from 'next/navigation';

/** Convenience alias — the real accounts UI lives under /app. */
export default function AccountsRedirect() {
  redirect('/app/accounts');
}
