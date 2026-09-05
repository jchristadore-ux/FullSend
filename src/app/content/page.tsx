import { redirect } from 'next/navigation';

/** Legacy /content → app content. */
export default function ContentRedirect() {
  redirect('/app/content');
}
