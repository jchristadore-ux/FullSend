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
  type QueryOptions,
  type Store,
  type TableName,
  type Tables,
  TENANT_KEY,
  type TenantScope,
} from './store';

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

  /** Applies the tenant predicate to a select/update/delete builder. */
  private async scopeQuery(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: any,
    scope: TenantScope,
    table: TableName,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    if (scope.kind === 'system') return query;
    const key = TENANT_KEY[table];
    if (key === 'user_id') return query.eq('user_id', scope.userId);
    if (key === 'none') {
      if (table === 'users') return query.eq('id', scope.userId);
      return query;
    }
    const ids = await this.accessibleProjectIds(scope);
    if (ids === 'all') return query;
    // An empty tenant returns nothing rather than everything.
    return query.in('project_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  }

  private wrap(error: { message: string; code?: string }, table: string): FullSendError {
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
    q = await this.scopeQuery(q, scope, table);
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
    q = await this.scopeQuery(q, scope, table);

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
    q = await this.scopeQuery(q, scope, table);
    const { data, error } = await q.select().single();
    if (error) throw this.wrap(error, table);
    return data as Tables[K];
  }

  async remove<K extends TableName>(scope: TenantScope, table: K, id: Uuid): Promise<void> {
    const existing = await this.get(scope, table, id);
    if (!existing) return;
    let q = this.client.from(table).delete().eq('id', id);
    q = await this.scopeQuery(q, scope, table);
    const { error } = await q;
    if (error) throw this.wrap(error, table);
  }

  async count<K extends TableName>(
    scope: TenantScope,
    table: K,
    options: QueryOptions<Tables[K]> = {},
  ): Promise<number> {
    let q = this.client.from(table).select('id', { count: 'exact', head: true });
    q = await this.scopeQuery(q, scope, table);
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
  async claimNextJob(now: string, lockTimeoutMs: number): Promise<Job | null> {
    const staleBefore = new Date(Date.parse(now) - lockTimeoutMs).toISOString();
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await this.client
        .from('jobs')
        .select('*')
        .or(
          `and(status.eq.queued,run_after.lte.${now}),` +
            `and(status.eq.running,locked_at.lt.${staleBefore})`,
        )
        .order('run_after', { ascending: true })
        .limit(1);
      if (error) throw this.wrap(error, 'jobs');
      const candidate = (data ?? [])[0] as Job | undefined;
      if (!candidate) return null;

      const { data: claimed, error: claimErr } = await this.client
        .from('jobs')
        .update({
          status: 'running',
          locked_at: now,
          attempts: candidate.attempts + 1,
          updated_at: now,
        })
        .eq('id', candidate.id)
        .eq('status', candidate.status)
        .is('locked_at', candidate.locked_at)
        .select()
        .maybeSingle();
      if (claimErr) throw this.wrap(claimErr, 'jobs');
      if (claimed) return claimed as Job;
      // Lost the race; look for the next one.
    }
    return null;
  }
}
