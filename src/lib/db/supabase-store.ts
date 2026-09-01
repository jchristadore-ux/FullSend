/**
 * Supabase/Postgres driver.
 *
 * Uses the service-role key, so RLS is bypassed at the connection level — which
 * means this driver is responsible for applying the same tenant filter itself.
 * It does, on every read and write. RLS policies in the migration are the second
 * line of defence for anything that reaches Postgres through the anon key.
 */
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env';
import { forbidden, FullSendError, notFound } from '../errors';
import type { Job, Uuid } from '../types';
import {
  type ClaimOptions,
  type QueryOptions,
  type Store,
  type TableName,
  type Tables,
  TENANT_KEY,
  type TenantScope,
} from './store';

/**
 * How far down the queue a single claim will look for something it can take.
 *
 * Small: this is a fallback past a blocked row, not a batch size. One extra
 * round trip per blocked job is the price, and the alternative — stopping at
 * the first row that will not budge — stops the whole deployment.
 */
export const CLAIM_CANDIDATES = 10;

/** A tenant restriction as plain data, so it never travels as a query builder. */
type ScopeFilter =
  | { kind: 'unrestricted' }
  | { kind: 'eq'; column: string; value: string }
  | { kind: 'in'; column: string; values: string[] };

/**
 * True when the database answered "that table isn't there" — the signature of
 * a project whose migration has never been run.
 */
export function isSchemaMissing(error: { message?: string; code?: string }): boolean {
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  const m = (error.message ?? '').toLowerCase();
  return (
    m.includes('does not exist') ||
    m.includes('could not find the table') ||
    m.includes('schema cache')
  );
}

export class SupabaseStore implements Store {
  private client: SupabaseClient;
  /** project_id -> owning user_id, to avoid a lookup per row. */
  private ownerCache = new Map<Uuid, Uuid>();

  constructor(client?: SupabaseClient) {
    if (client) {
      this.client = client;
      return;
    }
    const { url, serviceRoleKey } = env.supabase;
    if (!url || !serviceRoleKey) {
      throw new FullSendError('db_not_configured', 'Supabase is not configured', {
        remedy:
          'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or set FULLSEND_DB_DRIVER=memory.',
      });
    }
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async accessibleProjectIds(scope: TenantScope): Promise<Uuid[] | 'all'> {
    if (scope.kind === 'system') return 'all';
    const { data, error } = await this.client
      .from('projects')
      .select('id')
      .eq('user_id', scope.userId);
    if (error) throw this.wrap(error, 'projects');
    return (data ?? []).map((r) => r.id as Uuid);
  }

  private async ownerOfProject(projectId: Uuid): Promise<Uuid | null> {
    const cached = this.ownerCache.get(projectId);
    if (cached) return cached;
    const { data, error } = await this.client
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .maybeSingle();
    if (error) throw this.wrap(error, 'projects');
    if (!data) return null;
    this.ownerCache.set(projectId, data.user_id as Uuid);
    return data.user_id as Uuid;
  }

  private async assertWriteAccess(
    scope: TenantScope,
    table: TableName,
    row: Record<string, unknown>,
  ): Promise<void> {
    if (scope.kind === 'system') return;
    const key = TENANT_KEY[table];
    if (key === 'none') {
      if (table === 'users' && row.id !== scope.userId) throw forbidden();
      return;
    }
    if (key === 'user_id') {
      if (row.user_id !== scope.userId) throw forbidden();
      return;
    }
    const owner = await this.ownerOfProject(row.project_id as Uuid);
    if (owner !== scope.userId) throw forbidden();
  }

  /*
   * Resolving the tenant restriction and applying it are deliberately two
   * steps, and the split is load-bearing.
   *
   * A PostgREST query builder is a thenable. Returning one from an `async`
   * function hands it to Promise.resolve, which assimilates any thenable by
   * calling its `then` — so the query executes then and there, and the caller
   * receives a `{ data, error }` response where it expected a builder it could
   * keep chaining. It fails only against a real Supabase, on the next `.eq()`
   * or `.maybeSingle()`, with a TypeError that says nothing about the cause.
   *
   * Resolving returns plain data. Applying is synchronous. No builder ever
   * passes through an await, so the hazard cannot recur here.
   */
  private async scopeFilter(scope: TenantScope, table: TableName): Promise<ScopeFilter> {
    if (scope.kind === 'system') return { kind: 'unrestricted' };

    const key = TENANT_KEY[table];
    if (key === 'user_id') return { kind: 'eq', column: 'user_id', value: scope.userId };
    if (key === 'none') {
      return table === 'users'
        ? { kind: 'eq', column: 'id', value: scope.userId }
        : { kind: 'unrestricted' };
    }

    const ids = await this.accessibleProjectIds(scope);
    if (ids === 'all') return { kind: 'unrestricted' };
    // An empty tenant returns nothing rather than everything.
    return {
      kind: 'in',
      column: 'project_id',
      values: ids.length ? ids : ['00000000-0000-0000-0000-000000000000'],
    };
  }

  private applyScope(query: any, filter: ScopeFilter): any {
    if (filter.kind === 'eq') return query.eq(filter.column, filter.value);
    if (filter.kind === 'in') return query.in(filter.column, filter.values);
    return query;
  }

  private wrap(error: { message: string; code?: string }, table: string): FullSendError {
    /*
     * A missing table is not transient, and no number of retries creates one.
     * Calling it transient sends the job queue into a retry cycle that can
     * never succeed while telling the founder to wait for a recovery that is
     * not coming — when the actual fix is one migration they have not run.
     *
     * 42P01 is Postgres for "undefined table"; PGRST205 is PostgREST failing
     * to find it in the schema cache, which is what a fresh project returns.
     */
    if (isSchemaMissing(error)) {
      return new FullSendError('db_schema_missing', `The \`${table}\` table does not exist`, {
        retryable: false,
        remedy:
          'Run supabase/migrations/0001_fullsend_init.sql in the Supabase SQL Editor. It creates every table and the rules that keep tenants separate.',
        meta: { table, code: error.code },
      });
    }

    return new FullSendError('db_error', `Database error on ${table}: ${error.message}`, {
      retryable: true,
      remedy: 'This is usually transient. FullSend will retry automatically.',
      meta: { table, code: error.code },
    });
  }

  async insert<K extends TableName>(
    scope: TenantScope,
    table: K,
    row: Tables[K],
  ): Promise<Tables[K]> {
    await this.assertWriteAccess(scope, table, row as unknown as Record<string, unknown>);
    const { data, error } = await this.client.from(table).insert(row).select().single();
    if (error) throw this.wrap(error, table);
    return data as Tables[K];
  }

  async insertMany<K extends TableName>(
    scope: TenantScope,
    table: K,
    rows: Tables[K][],
  ): Promise<Tables[K][]> {
    if (rows.length === 0) return [];
    for (const row of rows) {
      await this.assertWriteAccess(scope, table, row as unknown as Record<string, unknown>);
    }
    const { data, error } = await this.client.from(table).insert(rows).select();
    if (error) throw this.wrap(error, table);
    return (data ?? []) as Tables[K][];
  }

  async get<K extends TableName>(
    scope: TenantScope,
    table: K,
    id: Uuid,
  ): Promise<Tables[K] | null> {
    let q = this.client.from(table).select('*').eq('id', id);
    q = this.applyScope(q, await this.scopeFilter(scope, table));
    const { data, error } = await q.maybeSingle();
    if (error) throw this.wrap(error, table);
    return (data as Tables[K]) ?? null;
  }

  async find<K extends TableName>(
    scope: TenantScope,
    table: K,
    options: QueryOptions<Tables[K]> = {},
  ): Promise<Tables[K][]> {
    let q = this.client.from(table).select('*');
    q = this.applyScope(q, await this.scopeFilter(scope, table));

    const { where, whereIn, gte, lt, orderBy, direction = 'asc', limit, offset } = options;
    if (where) {
      for (const [k, v] of Object.entries(where)) {
        if (v === undefined) continue;
        q = v === null ? q.is(k, null) : q.eq(k, v);
      }
    }
    if (whereIn) {
      for (const [k, vals] of Object.entries(whereIn)) {
        if (!vals) continue;
        q = q.in(k, vals as unknown[]);
      }
    }
    if (gte) for (const [k, v] of Object.entries(gte)) if (v !== undefined) q = q.gte(k, v);
    if (lt) for (const [k, v] of Object.entries(lt)) if (v !== undefined) q = q.lt(k, v);
    if (orderBy) q = q.order(orderBy as string, { ascending: direction === 'asc' });
    if (limit !== undefined) q = q.range(offset ?? 0, (offset ?? 0) + limit - 1);
    else if (offset) q = q.range(offset, offset + 999);

    const { data, error } = await q;
    if (error) throw this.wrap(error, table);
    return (data ?? []) as Tables[K][];
  }

  async findOne<K extends TableName>(
    scope: TenantScope,
    table: K,
    options: QueryOptions<Tables[K]> = {},
  ): Promise<Tables[K] | null> {
    const rows = await this.find(scope, table, { ...options, limit: 1 });
    return rows[0] ?? null;
  }

  async update<K extends TableName>(
    scope: TenantScope,
    table: K,
    id: Uuid,
    patch: Partial<Tables[K]>,
  ): Promise<Tables[K]> {
    // Read first so the tenant check runs against stored ownership, not the patch.
    const existing = await this.get(scope, table, id);
    if (!existing) throw notFound(table);
    let q = this.client
      .from(table)
      .update(patch as Record<string, unknown>)
      .eq('id', id);
    q = this.applyScope(q, await this.scopeFilter(scope, table));
    const { data, error } = await q.select().single();
    if (error) throw this.wrap(error, table);
    return data as Tables[K];
  }

  async remove<K extends TableName>(scope: TenantScope, table: K, id: Uuid): Promise<void> {
    const existing = await this.get(scope, table, id);
    if (!existing) return;
    let q = this.client.from(table).delete().eq('id', id);
    q = this.applyScope(q, await this.scopeFilter(scope, table));
    const { error } = await q;
    if (error) throw this.wrap(error, table);
  }

  async count<K extends TableName>(
    scope: TenantScope,
    table: K,
    options: QueryOptions<Tables[K]> = {},
  ): Promise<number> {
    let q = this.client.from(table).select('id', { count: 'exact', head: true });
    q = this.applyScope(q, await this.scopeFilter(scope, table));
    const { where } = options;
    if (where) {
      for (const [k, v] of Object.entries(where)) {
        if (v === undefined) continue;
        q = v === null ? q.is(k, null) : q.eq(k, v);
      }
    }
    const { count, error } = await q;
    if (error) throw this.wrap(error, table);
    return count ?? 0;
  }

  /**
   * Atomic claim. The conditional `.eq('status', candidate.status)` makes the
   * update lose harmlessly if another worker got there first, and we retry.
   */
  /**
   * The claim's selection, built once so the counter and the claimer can never
   * disagree about what "takeable" means.
   */
  private claimableQuery(now: string, lockTimeoutMs: number, opts: ClaimOptions, columns: string) {
    const { projectId, createdBefore } = opts;
    const staleBefore = new Date(Date.parse(now) - lockTimeoutMs).toISOString();
    let query = this.client
      .from('jobs')
      .select(columns, columns === 'id' ? { count: 'exact', head: true } : undefined)
      .or(
        `and(status.eq.queued,run_after.lte.${now}),` +
          `and(status.eq.running,locked_at.lt.${staleBefore})`,
      );
    if (projectId) query = query.eq('project_id', projectId);
    if (createdBefore) query = query.lte('created_at', createdBefore);
    return query;
  }

  async countClaimable(now: string, lockTimeoutMs: number, opts: ClaimOptions = {}): Promise<number> {
    const { count, error } = await this.claimableQuery(now, lockTimeoutMs, opts, 'id');
    if (error) throw this.wrap(error, 'jobs');
    return count ?? 0;
  }

  async claimNextJob(
    now: string,
    lockTimeoutMs: number,
    opts: ClaimOptions = {},
  ): Promise<Job | null> {
    const { projectId, createdBefore } = opts;
    const staleBefore = new Date(Date.parse(now) - lockTimeoutMs).toISOString();

    let query = this.client
      .from('jobs')
      .select('*')
      .or(
        `and(status.eq.queued,run_after.lte.${now}),` +
          `and(status.eq.running,locked_at.lt.${staleBefore})`,
      );
    if (projectId) query = query.eq('project_id', projectId);
    if (createdBefore) query = query.lte('created_at', createdBefore);
    /*
     * Several candidates, not one, and this is the difference between a queue
     * and a queue-shaped deadlock.
     *
     * Asking for `.limit(1)` meant every claim in the deployment looked at the
     * same single row: the oldest due job. A row that cannot be claimed —
     * whatever the reason — was therefore not one stuck job, it was a stopped
     * queue, for every project, permanently. That is exactly what happened
     * here: one `generate_strategy` job sat at the head of the queue, due and
     * unclaimed for eight hours, and nothing behind it ran for four.
     *
     * The retry loop made it worse rather than better, because all five
     * attempts re-selected the same blocked row.
     *
     * A worker now walks the head of the queue until something claims, so a
     * row it cannot take costs one attempt instead of the whole pass.
     */
    const { data, error } = await query.order('run_after', { ascending: true }).limit(CLAIM_CANDIDATES);
    if (error) throw this.wrap(error, 'jobs');
    const candidates = (data ?? []) as Job[];

    for (const candidate of candidates) {
      let claim = this.client
        .from('jobs')
        .update({
          status: 'running',
          locked_at: now,
          attempts: candidate.attempts + 1,
          updated_at: now,
          // Reclaiming a job whose worker died is the only record that it
          // died: the worker was killed before it could write anything.
          last_error:
            candidate.status === 'running'
              ? 'The previous attempt was cut off before it finished.'
              : candidate.last_error,
        })
        .eq('id', candidate.id)
        .eq('status', candidate.status);
      /*
       * The lock is part of the compare-and-set, so a worker that reclaims a
       * stale job loses harmlessly to whoever got there first.
       *
       * `.is()` is only valid against null, true and false. Passing it a
       * timestamp builds `locked_at=is.2026-01-01T00:00:00Z`, which PostgREST
       * rejects outright — so every reclaim of a dead worker's job threw
       * instead of recovering it, which is precisely the case this exists for.
       */
      claim =
        candidate.locked_at === null
          ? claim.is('locked_at', null)
          : claim.eq('locked_at', candidate.locked_at);

      const { data: claimed, error: claimErr } = await claim.select().maybeSingle();
      if (claimErr) throw this.wrap(claimErr, 'jobs');
      if (claimed) return claimed as Job;
      // Lost the race, or this row will not budge. Either way, try the next.
    }
    return null;
  }
}
