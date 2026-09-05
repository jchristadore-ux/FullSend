import { redirect } from 'next/navigation';

/** Legacy /accounts → app accounts. */
export default function AccountsRedirect() {
  redirect('/app/accounts');
}
