import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { activeProject } from '@/lib/active-project';
import { listSocialAccounts } from '@/lib/db/repo';
import { platformStatus } from '@/lib/social/registry';
import { publicAccount } from '@/lib/social/account-view';
import { setupGuide, setupValues } from '@/lib/social/setup-guides';
import { storageAvailable } from '@/lib/creative/media';
import { env } from '@/lib/env';
import { AccountsView, type AccountCandidate } from '@/components/app/AccountsView';
import { PLATFORMS, type Platform } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Accounts' };

/**
 * The account chooser's payload, as it came back from the callback.
 *
 * Ids and usernames only — the callback base64s exactly that and nothing else.
 * Parsed defensively because it arrives on a URL: anything that is not the
 * expected shape becomes an empty list, and the page falls back to the
 * ordinary Connect button.
 */
function parseCandidates(encoded: string | undefined): AccountCandidate[] {
  if (!encoded) return [];
  try {
    const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((c) => c && typeof c.externalId === 'string')
      .map((c) => ({
        externalId: String(c.externalId),
        username: String(c.username ?? ''),
        displayName: c.displayName ? String(c.displayName) : null,
        followers: Number(c.followers ?? 0),
      }));
  } catch {
    return [];
  }
}

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{
    connected?: string;
    error?: string;
    reconnect?: string;
    choose?: string;
    candidates?: string;
  }>;
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
      projectName={project.name}
      storageReady={storageAvailable()}
      values={setupValues(env.appUrl, mediaPrefix)}
      platforms={status.map((s) => ({
        ...s,
        // Never the stored row: it carries a metadata column that has held a
        // live publishing credential.
        account: publicAccount(accounts.find((a) => a.platform === s.platform) ?? null),
        guide: setupGuide(s.platform),
      }))}
      notice={{
        connected: params.connected ?? null,
        error: params.error ?? null,
        reconnect: params.reconnect ?? null,
        /*
         * Checked against the known platforms rather than trusted. It arrives
         * on a URL and is built into the href of a button somebody is about to
         * press; a value from a query string has no business deciding where
         * that link points.
         */
        choosePlatform: PLATFORMS.includes(params.choose as Platform)
          ? (params.choose as Platform)
          : null,
        candidates: parseCandidates(params.candidates),
      }}
    />
  );
}
