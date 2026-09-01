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
import { CLAIM_CANDIDATES, SupabaseStore } from '@/lib/db/supabase-store';
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

  /*
   * The bug this exists to prevent coming back, and it was not a small one.
   *
   * The claim selected exactly one candidate — the oldest due job — and if
   * that row could not be claimed, returned nothing. So a single stuck row was
   * never one stuck job: it was a stopped queue, for every project, for as
   * long as the row sat there. In production one `generate_strategy` job did
   * exactly that, and nothing else ran for four hours behind it.
   */
  it('looks past a row it cannot claim instead of stopping the queue', async () => {
    const blocked = { ...JOB, id: 'blocked', run_after: '2026-01-01T00:00:00.000Z' };
    const behind = { ...JOB, id: 'behind', run_after: '2026-01-01T00:01:00.000Z' };

    const calls: Call[] = [];
    let claimAttempts = 0;
    const client = {
      from(table: string) {
        calls.push({ method: 'from', args: [table] });
        const self: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'is', 'gte', 'lte', 'lt', 'or', 'update', 'order', 'limit', 'range']) {
          self[m] = (...args: unknown[]) => {
            calls.push({ method: m, args });
            return self;
          };
        }
        // The claim: the first row refuses, the one behind it accepts.
        self.maybeSingle = () => {
          claimAttempts++;
          return Promise.resolve({ data: claimAttempts === 1 ? null : behind, error: null });
        };
        self.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: [blocked, behind], error: null, count: 2 }).then(resolve);
        return self;
      },
    } as unknown as SupabaseClient;

    const claimed = await new SupabaseStore(client).claimNextJob(
      '2026-01-02T00:00:00.000Z',
      60_000,
    );

    expect(claimed?.id).toBe('behind');
    expect(claimAttempts).toBe(2);
  });

  it('asks for more than one candidate so there is something to fall past', async () => {
    const { client, calls } = fakeClient([JOB]);
    const store = new SupabaseStore(client);

    await store.claimNextJob('2026-01-02T00:00:00.000Z', 60_000);

    const limits = calls.filter((c) => c.method === 'limit');
    expect(limits.some((c) => c.args[0] === CLAIM_CANDIDATES)).toBe(true);
    expect(CLAIM_CANDIDATES).toBeGreaterThan(1);
  });

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
