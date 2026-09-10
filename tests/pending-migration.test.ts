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
