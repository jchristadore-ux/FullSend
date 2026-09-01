/**
 * Migrations, from the Control Room.
 *
 * GET  — what this database has and what it is missing.
 * POST — apply the missing ones, or record already-applied ones as done.
 *
 * Admin-only. Applying schema changes is the most destructive thing this
 * application can be asked to do, so it takes a signed-in admin making an
 * explicit request; nothing here runs on a schedule or on deploy.
 */
import { route } from '@/lib/api/handler';
import { z } from 'zod';
import { FullSendError } from '@/lib/errors';
import { applyPendingMigrations, baselineMigrations, migrationReport } from '@/lib/db/migrate';
import { audit } from '@/lib/db/repo';
import { systemScope } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function assertAdmin(isAdmin: boolean): void {
  if (isAdmin) return;
  throw new FullSendError('forbidden', 'This needs an admin account', {
    status: 403,
    remedy: 'Add your email to FULLSEND_ADMIN_EMAILS and sign in again.',
  });
}

export const GET = route(async ({ session }) => {
  assertAdmin(session.user.is_admin);
  return migrationReport();
});

export const POST = route(
  async ({ session, body }) => {
    assertAdmin(session.user.is_admin);

    if (body.action === 'baseline') {
      const result = await baselineMigrations();
      await audit(systemScope('admin:migrations'), {
        user_id: session.user.id,
        project_id: null,
        action: 'migrations.baselined',
        target: result.recorded.join(', ') || 'nothing to record',
        metadata: { recorded: result.recorded },
        ip: null,
      });
      return { ...result, report: await migrationReport() };
    }

    const result = await applyPendingMigrations();
    await audit(systemScope('admin:migrations'), {
      user_id: session.user.id,
      project_id: null,
      action: 'migrations.applied',
      target: result.applied.join(', ') || 'nothing to apply',
      metadata: { applied: result.applied, failed: result.failed },
      ip: null,
    });

    return { ...result, report: await migrationReport() };
  },
  { schema: z.object({ action: z.enum(['apply', 'baseline']).default('apply') }) },
);
