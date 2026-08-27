/**
 * The deletion promises.
 *
 * /privacy and /data-deletion tell a founder — and a platform reviewer — that
 * disconnecting removes the stored tokens and that deleting a project removes
 * everything hanging off it. Both are load-bearing claims: Meta and TikTok
 * require a working deletion path, and a policy that describes one the code
 * does not have is the kind of thing that gets an app pulled rather than
 * merely rejected. These tests are what keeps the pages honest.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectPlatform,
  createProject,
  setupContext,
  teardown,
  type TestContext,
} from './helpers';
import { db } from '@/lib/db/repo';
import { systemScope, TENANT_KEY, type TableName } from '@/lib/db';
import { disconnect } from '@/lib/social/connections';
import { newId, nowIso } from '@/lib/ids';
import type { Project } from '@/lib/types';

/** Every table Postgres cascades from `projects`, i.e. every one carrying a project_id. */
const CASCADING: TableName[] = (Object.keys(TENANT_KEY) as TableName[]).filter(
  (t) => TENANT_KEY[t] === 'project_id',
);

/**
 * Counts a project's rows in a table chosen at runtime.
 *
 * `where` is typed per-table, so iterating over a union of table names needs
 * the cast — the alternative is 25 hand-written assertions that drift the
 * moment a table is added.
 */
async function countFor(table: TableName, projectId: string): Promise<number> {
  const rows = await db().find(systemScope('test'), table, {
    where: { project_id: projectId } as never,
  });
  return rows.length;
}

describe('deletion', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
  });

  afterEach(() => teardown());

  it('destroys the stored tokens when an account is disconnected', async () => {
    await connectPlatform(ctx.scope, project, 'instagram');

    const before = await db().find(systemScope('test'), 'oauth_tokens', {
      where: { project_id: project.id },
    });
    expect(before).toHaveLength(1);
    expect(before[0].access_token_encrypted).toBeTruthy();

    await disconnect(ctx.scope, project, 'instagram');

    // Not merely marked revoked — the row is gone, so there is no ciphertext
    // left to decrypt even with the encryption key and database access.
    const after = await db().find(systemScope('test'), 'oauth_tokens', {
      where: { project_id: project.id },
    });
    expect(after).toHaveLength(0);
  });

  it('leaves the account visible but disconnected, so history still reads', async () => {
    await connectPlatform(ctx.scope, project, 'instagram');
    await disconnect(ctx.scope, project, 'instagram');

    const accounts = await db().find(ctx.scope, 'social_accounts', {
      where: { project_id: project.id },
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0].status).toBe('disconnected');
  });

  it('takes every dependent row with it when a project is deleted', async () => {
    await connectPlatform(ctx.scope, project, 'instagram');

    // One row in each cascading table, so nothing can pass by being empty.
    for (const table of CASCADING) {
      await db().insert(systemScope('test'), table, {
        id: newId(),
        project_id: project.id,
        created_at: nowIso(),
      } as never);
    }

    for (const table of CASCADING) {
      expect(
        await countFor(table, project.id),
        `${table} should have a row before the delete`,
      ).toBeGreaterThan(0);
    }

    await db().remove(ctx.scope, 'projects', project.id);

    for (const table of CASCADING) {
      expect(
        await countFor(table, project.id),
        `${table} should be empty after the project is deleted`,
      ).toBe(0);
    }
  });

  it('does not touch another project while deleting one', async () => {
    const keep = await createProject(ctx.scope, ctx.user.id, { name: 'Keep', slug: 'keep' });
    await connectPlatform(ctx.scope, project, 'instagram');
    await connectPlatform(ctx.scope, keep, 'tiktok');

    await db().remove(ctx.scope, 'projects', project.id);

    const survivors = await db().find(systemScope('test'), 'oauth_tokens', {
      where: { project_id: keep.id },
    });
    expect(survivors).toHaveLength(1);
  });
});
