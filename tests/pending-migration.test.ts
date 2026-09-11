/**
 * A deployment whose migration has not been applied yet.
 *
 * Code ships, then an admin applies the pending migration — that ordering is
 * how every deploy works, and the product has to stay standing in the gap.
 * `website_sources` arrives in 0007, and a hard failure reading it took the
 * analysis endpoint down for every GitHub project that predates the feature.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, setupContext, teardown, type TestContext } from './helpers';
import { MemoryStore, setStore, type Store, type TableName } from '@/lib/db';
import { FullSendError } from '@/lib/errors';
import { getWebsiteSource } from '@/lib/db/repo';
import {
  INITIAL_MIGRATION,
  LATER_TABLES,
  migrationCreating,
  migrationRemedy,
} from '@/lib/db/table-origins';
import { MIGRATIONS } from '@/lib/db/migration-sql.generated';

/** A store that answers "that table isn't there" for one table. */
function storeWithout(inner: MemoryStore, missing: TableName): Store {
  const schemaMissing = () =>
    new FullSendError('db_schema_missing', `The \`${missing}\` table does not exist`, {
      retryable: false,
      remedy: 'Apply the pending migrations from the Control Room.',
    });

  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop !== 'find' && prop !== 'findOne' && prop !== 'get' && prop !== 'insert') {
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        if (args[1] === missing) return Promise.reject(schemaMissing());
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as Store;
}

describe('reading a table migration 0007 has not created yet', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupContext();
  });

  afterEach(() => teardown());

  it('reports no website source instead of failing the read', async () => {
    const project = await createProject(ctx.scope, ctx.user.id);
    setStore(storeWithout(ctx.store, 'website_sources'));

    await expect(getWebsiteSource(ctx.scope, project.id)).resolves.toBeNull();
  });

  it('still surfaces a real database error', async () => {
    const project = await createProject(ctx.scope, ctx.user.id);
    const broken = new Proxy(ctx.store, {
      get(target, prop, receiver) {
        if (prop === 'findOne') {
          return () =>
            Promise.reject(
              new FullSendError('db_error', 'connection reset', { retryable: true }),
            );
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as Store;
    setStore(broken);

    await expect(getWebsiteSource(ctx.scope, project.id)).rejects.toThrow('connection reset');
  });
});

describe('the remedy a missing table gives', () => {
  it('names the migration that actually creates that table', () => {
    expect(migrationCreating('website_sources')).toBe('0007_website_source.sql');
    const remedy = migrationRemedy('website_sources');
    expect(remedy).toContain('0007_website_source.sql');
    expect(remedy).toContain('Control Room');
    // The old answer sent everyone to 0001, which does not create this table.
    expect(remedy).not.toContain('0001_fullsend_init.sql');
  });

  it('still points at the initial schema for a table 0001 creates', () => {
    expect(migrationCreating('projects')).toBe('0001_fullsend_init.sql');
    expect(migrationRemedy('projects')).toContain('0001_fullsend_init.sql');
  });

  it('carries that remedy on the error a caller receives', () => {
    const err = new FullSendError('db_schema_missing', 'The `website_sources` table does not exist', {
      retryable: false,
      remedy: migrationRemedy('website_sources'),
      meta: { migration: migrationCreating('website_sources') },
    });
    expect(err.toJSON().remedy).toContain('0007_website_source.sql');
    expect(err.retryable).toBe(false);
  });
});

/**
 * Keeps `table-origins` honest against the migrations themselves.
 *
 * The map is plain data so the driver does not carry the migration SQL into
 * every serverless bundle. The cost of that is drift, and this is what pays it:
 * a table introduced by a later migration with no entry fails here.
 */
describe('every table names the migration that creates it', () => {
  it('agrees with the migration SQL', () => {
    const created = new Map<string, string>();
    const pattern = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi;
    for (const migration of MIGRATIONS) {
      for (const match of migration.sql.matchAll(pattern)) {
        if (!created.has(match[1])) created.set(match[1], migration.name);
      }
    }
    expect(created.get('projects')).toBe(INITIAL_MIGRATION);

    for (const [table, migration] of created) {
      expect(migrationCreating(table), `${table} is created by ${migration}`).toBe(migration);
    }
    for (const table of Object.keys(LATER_TABLES)) {
      expect(created.has(table), `${table} is not created by any migration`).toBe(true);
    }
  });
});
