import { redirect } from 'next/navigation';

/** Convenience alias — the real content UI lives under /app. */
export default function ContentRedirect() {
  redirect('/app/content');
}
