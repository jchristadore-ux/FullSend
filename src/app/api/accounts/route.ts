import { z } from 'zod';
import { route } from '@/lib/api/handler';
import { db, getProject, listSocialAccounts } from '@/lib/db/repo';
import { badRequest, notFound } from '@/lib/errors';
import { disconnect } from '@/lib/social/connections';
import { verifyConnection } from '@/lib/automation/autopilot';
import { platformStatus } from '@/lib/social/registry';
import { publicAccount, publicAccounts } from '@/lib/social/account-view';
import { metaAppConfig } from '@/lib/social/meta-app';
import { setupGuide, setupValues } from '@/lib/social/setup-guides';
import { storageAvailable } from '@/lib/creative/media';
import { env } from '@/lib/env';
import { PLATFORMS, type Platform } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * Everything the Accounts page shows.
 *
 * Accounts go out through `publicAccount`, never as stored rows. The stored
 * row carries `platform_metadata`, which is a free-form column that has held a
 * live Facebook Page token — returning rows verbatim published a publishing
 * credential to every browser that loaded this page.
 */
export const GET = route(async ({ session, req }) => {
  const projectId = new URL(req.url).searchParams.get('project');
  if (!projectId) throw badRequest('No project specified');

  const project = await getProject(session.scope, projectId);
  if (!project) throw notFound('Project');

  const accounts = await listSocialAccounts(session.scope, project.id);
  const status = platformStatus();
  const meta = metaAppConfig();

  const mediaPrefix = storageAvailable()
    ? `${env.supabase.url}/storage/v1/object/public/${env.supabase.storageBucket}/`
    : null;

  return {
    accounts: publicAccounts(accounts),
    platforms: status.map((s) => ({
      ...s,
      account: publicAccount(accounts.find((a) => a.platform === s.platform) ?? null),
      guide: setupGuide(s.platform),
    })),
    setupValues: setupValues(env.appUrl, mediaPrefix),
    storageReady: storageAvailable(),
    /*
     * The application, as distinct from the accounts on it. One Meta app
     * serves every brand, so whether it is configured is a fact about the
     * deployment — and stating it here is what stops the second account being
     * treated as a second setup.
     */
    metaApp: {
      configured: meta.configured,
      loginMode: meta.loginMode,
      scopes: meta.scopes,
      redirectUri: meta.redirectUri,
    },
  };
});

/** Disconnect, or re-verify a connection's health. */
export const POST = route(
  async ({ session, body }) => {
    const project = await getProject(session.scope, body.projectId);
    if (!project) throw notFound('Project');
    if (!PLATFORMS.includes(body.platform as Platform)) throw badRequest('Unknown platform');
    const platform = body.platform as Platform;

    if (body.action === 'disconnect') {
      await disconnect(session.scope, project, platform);
      return { disconnected: true };
    }

    const result = await verifyConnection(project.id, platform);
    const account = await db().findOne(session.scope, 'social_accounts', {
      where: { project_id: project.id, platform },
    });
    return { ...result, account: publicAccount(account) };
  },
  {
    schema: z.object({
      projectId: z.string().min(1),
      platform: z.string().min(1),
      action: z.enum(['disconnect', 'verify']),
    }),
  },
);
