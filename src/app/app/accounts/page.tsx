import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { activeProject } from '@/lib/active-project';
import { listSocialAccounts } from '@/lib/db/repo';
import { platformStatus } from '@/lib/social/registry';
import { setupGuide, setupValues } from '@/lib/social/setup-guides';
import { storageAvailable } from '@/lib/creative/media';
import { env } from '@/lib/env';
import { AccountsView } from '@/components/app/AccountsView';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Accounts' };

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string; reconnect?: string }>;
}) {
  const session = await requireSession();
  const project = await activeProject(session);
  if (!project) redirect('/onboarding');

  const params = await searchParams;
  const accounts = await listSocialAccounts(session.scope, project.id);
  const status = platformStatus().filter((s) => s.live);

  const mediaPrefix = storageAvailable()
    ? `${env.supabase.url}/storage/v1/object/public/${env.supabase.storageBucket}/`
    : null;

  return (
    <AccountsView
      projectId={project.id}
      storageReady={storageAvailable()}
      values={setupValues(env.appUrl, mediaPrefix)}
      platforms={status.map((s) => ({
        ...s,
        account: accounts.find((a) => a.platform === s.platform) ?? null,
        guide: setupGuide(s.platform),
      }))}
      notice={{
        connected: params.connected ?? null,
        error: params.error ?? null,
        reconnect: params.reconnect ?? null,
      }}
    />
  );
}
