/**
 * The Supabase driver, against a stand-in for PostgREST.
 *
 * Every other test runs on MemoryStore, so this driver's query building never
 * executed anywhere before production. The bug that prompted these tests could
 * not have been caught by a stub that is merely an object with methods: it
 * depended on the real builder being a *thenable*, which is what makes `await`
 * execute a query. The fake here is thenable for that reason, and a premature
 * await fails it the same way it failed in production.
 */
import { describe, expect, it } from 'vitest';
import { SupabaseStore } from '@/lib/db/supabase-store';
import { systemScope, userScope } from '@/lib/db';
import type { SupabaseClient } from '@supabase/supabase-js';

interface Call {
  method: string;
  args: unknown[];
}

/**
 * A PostgREST query builder as far as this driver can tell: chainable, and
 * thenable so that awaiting it runs the query.
 */
function builder(rows: unknown[], calls: Call[]) {
  const self: Record<string, unknown> = {};
  for (const method of [
    'select',
    'eq',
    'in',
    'is',
    'gte',
    'lte',
    'lt',
    'or',
    'update',
    'order',
    'limit',
    'range',
  ]) {
    self[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return self;
    };
  }
  const settle = () => ({ data: rows, error: null, count: rows.length });
  self.maybeSingle = () => {
    calls.push({ method: 'maybeSingle', args: [] });
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  };
  self.single = () => Promise.resolve({ data: rows[0] ?? null, error: null });
  // The thenable. This is the whole point of the fake.
  self.then = (resolve: (v: unknown) => unknown) => {
    calls.push({ method: 'then', args: [] });
    return Promise.resolve(settle()).then(resolve);
  };
  return self;
}

function fakeClient(rows: unknown[] = []): { client: SupabaseClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      calls.push({ method: 'from', args: [table] });
      return builder(rows, calls);
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const USER = '11111111-1111-1111-1111-111111111111';
const ROW = { id: USER, email: 'founder@example.com' };

describe('the Supabase driver builds queries without executing them early', () => {
  it('reaches maybeSingle on a system-scoped get', async () => {
    const { client, calls } = fakeClient([ROW]);
    const store = new SupabaseStore(client);

    const got = await store.get(systemScope('test'), 'users', USER);

    expect(got).toEqual(ROW);
    expect(calls.map((c) => c.method)).toContain('maybeSingle');
  });

  it('never awaits the builder before the query is finished', async () => {
    const { client, calls } = fakeClient([ROW]);
    const store = new SupabaseStore(client);

    await store.get(systemScope('test'), 'users', USER);

    // `then` firing mid-chain is the signature of the builder being awaited —
    // Promise.resolve assimilating a thenable returned from an async function.
    const thenAt = calls.findIndex((c) => c.method === 'then');
    const doneAt = calls.findIndex((c) => c.method === 'maybeSingle');
    expect(doneAt).toBeGreaterThanOrEqual(0);
    if (thenAt >= 0) expect(thenAt).toBeGreaterThan(doneAt);
  });

  it('still applies the tenant filter on a user-scoped get', async () => {
    const { client, calls } = fakeClient([ROW]);
    const store = new SupabaseStore(client);

    await store.get(userScope(USER), 'users', USER);

    // `users` is scoped by its own id, so the row a tenant reads is their own.
    const eqs = calls.filter((c) => c.method === 'eq');
    expect(eqs.some((c) => c.args[0] === 'id' && c.args[1] === USER)).toBe(true);
    expect(calls.map((c) => c.method)).toContain('maybeSingle');
  });

  it('restricts a project-scoped find to the tenant’s own projects', async () => {
    const { client, calls } = fakeClient([]);
    const store = new SupabaseStore(client);

    await store.find(userScope(USER), 'content_items', {});

    const ins = calls.filter((c) => c.method === 'in');
    expect(ins.some((c) => c.args[0] === 'project_id')).toBe(true);
  });
});

describe('claiming a job', () => {
  const JOB = {
    id: '22222222-2222-2222-2222-222222222222',
    status: 'queued',
    attempts: 0,
    locked_at: null,
    run_after: '2026-01-01T00:00:00.000Z',
  };

  it('compares an unlocked job against null', async () => {
    const { client, calls } = fakeClient([JOB]);
    const store = new SupabaseStore(client);

    await store.claimNextJob('2026-01-02T00:00:00.000Z', 60_000);

    expect(calls.some((c) => c.method === 'is' && c.args[0] === 'locked_at' && c.args[1] === null))
      .toBe(true);
  });

  it('compares a dead worker’s lock with eq, never is', async () => {
    /*
     * `.is()` accepts null, true and false — nothing else. Passing it a
     * timestamp builds `locked_at=is.2026-01-01T…`, which PostgREST rejects,
     * so every attempt to reclaim a job from a worker that died threw instead
     * of recovering it. That is the one case the lease exists for, and no
     * MemoryStore test could see it.
     */
    const stale = { ...JOB, status: 'running', locked_at: '2026-01-01T00:00:00.000Z' };
    const { client, calls } = fakeClient([stale]);
    const store = new SupabaseStore(client);

    await store.claimNextJob('2026-01-02T00:00:00.000Z', 60_000);

    const lockFilters = calls.filter((c) => c.args[0] === 'locked_at');
    expect(lockFilters.some((c) => c.method === 'eq' && c.args[1] === stale.locked_at)).toBe(true);
    expect(lockFilters.some((c) => c.method === 'is')).toBe(false);
  });

  it('bounds the claim to jobs that existed when the pass began', async () => {
    const { client, calls } = fakeClient([JOB]);
    const store = new SupabaseStore(client);

    await store.claimNextJob('2026-01-02T00:00:00.000Z', 60_000, {
      createdBefore: '2026-01-02T00:00:00.000Z',
    });

    expect(
      calls.some(
        (c) =>
          c.method === 'lte' &&
          c.args[0] === 'created_at' &&
          c.args[1] === '2026-01-02T00:00:00.000Z',
      ),
    ).toBe(true);
  });
});
