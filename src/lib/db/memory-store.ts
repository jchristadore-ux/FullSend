/**
 * In-process store.
 *
 * This is not a stub: it implements the same tenant rules as the Supabase
 * driver, including the project-ownership check and atomic job claiming. It
 * backs the test suite and lets the whole product run end-to-end with no
 * external database, which is how the E2E chain is exercised in CI.
 */

import { forbidden, FullSendError, notFound } from '../errors';
import type { Job, Project, Uuid } from '../types';
import {
  type ClaimOptions,
  type QueryOptions,
  type Store,
  type TableName,
  type Tables,
  TENANT_KEY,
  type TenantScope,
} from './store';

type Row = Record<string, unknown> & { id: Uuid };

/**
 * The unique indexes the migration declares, mirrored here.
 *
 * These are not decoration in Postgres — they are the last thing standing
 * between two racing workers and the same post published twice, or the same
 * idea written twice. A memory driver that let those through would agree with
 * production right up to the moment it mattered, so the tests would prove
 * nothing about the constraint they most rely on.
 */
const UNIQUE_INDEXES: Partial<Record<TableName, string[][]>> = {
  published_posts: [['scheduled_post_id'], ['platform', 'external_id']],
  content_items: [['project_id', 'dedup_hash']],
};

export class MemoryStore implements Store {
  private tables = new Map<TableName, Map<Uuid, Row>>();
  /** Guards claimNextJob against interleaved async claims in one process. */
  private jobLock = Promise.resolve();

  private table(name: TableName): Map<Uuid, Row> {
    let t = this.tables.get(name);
    if (!t) {
      t = new Map();
      this.tables.set(name, t);
    }
    return t;
  }

  async reset(): Promise<void> {
    this.tables.clear();
  }

  async accessibleProjectIds(scope: TenantScope): Promise<Uuid[] | 'all'> {
    if (scope.kind === 'system') return 'all';
    const projects = [...this.table('projects').values()] as unknown as Project[];
    return projects.filter((p) => p.user_id === scope.userId).map((p) => p.id);
  }

  /** Throws unless `scope` owns the row. The isolation boundary. */
  private async assertAccess(scope: TenantScope, table: TableName, row: Row): Promise<void> {
    if (scope.kind === 'system') return;
    const key = TENANT_KEY[table];
    if (key === 'none') {
      // `users` rows: a user may only see themselves.
      if (table === 'users' && row.id !== scope.userId) throw forbidden();
      return;
    }
    if (key === 'user_id') {
      if (row.user_id !== scope.userId) throw forbidden();
      return;
    }
    const owned = await this.accessibleProjectIds(scope);
    if (owned !== 'all' && !owned.includes(row.project_id as Uuid)) throw forbidden();
  }

  async insert<K extends TableName>(
    scope: TenantScope,
    table: K,
    row: Tables[K],
  ): Promise<Tables[K]> {
    const r = row as unknown as Row;
    await this.assertAccess(scope, table, r);
    this.assertUnique(table, r);
    this.table(table).set(r.id, structuredClone(r));
    return structuredClone(row);
  }

  /** Refuses a row that would collide on a declared unique index. */
  private assertUnique(table: TableName, row: Row): void {
    const indexes = UNIQUE_INDEXES[table];
    if (!indexes) return;
    for (const columns of indexes) {
      // A null in any column means the row is outside the index, as in Postgres.
      if (columns.some((c) => row[c] === null || row[c] === undefined)) continue;
      for (const existing of this.table(table).values()) {
        if (existing.id === row.id) continue;
        if (columns.every((c) => existing[c] === row[c])) {
          throw new FullSendError(
            'unique_violation',
            `A ${table} row with the same ${columns.join(' + ')} already exists`,
            { status: 409, retryable: false },
          );
        }
      }
    }
  }

  async insertMany<K extends TableName>(
    scope: TenantScope,
    table: K,
    rows: Tables[K][],
  ): Promise<Tables[K][]> {
    const out: Tables[K][] = [];
    for (const row of rows) out.push(await this.insert(scope, table, row));
    return out;
  }

  async get<K extends TableName>(
    scope: TenantScope,
    table: K,
    id: Uuid,
  ): Promise<Tables[K] | null> {
    const row = this.table(table).get(id);
    if (!row) return null;
    await this.assertAccess(scope, table, row);
    return structuredClone(row) as unknown as Tables[K];
  }

  async find<K extends TableName>(
    scope: TenantScope,
    table: K,
    options: QueryOptions<Tables[K]> = {},
  ): Promise<Tables[K][]> {
    const key = TENANT_KEY[table];
    const owned = await this.accessibleProjectIds(scope);
    let rows = [...this.table(table).values()];

    // Tenant filter first — a caller can never widen it with `where`.
    if (scope.kind === 'user') {
      if (key === 'user_id') rows = rows.filter((r) => r.user_id === scope.userId);
      else if (key === 'project_id')
        rows = rows.filter((r) => owned !== 'all' && owned.includes(r.project_id as Uuid));
      else if (table === 'users') rows = rows.filter((r) => r.id === scope.userId);
    }

    const { where, whereIn, gte, lt, orderBy, direction = 'asc', limit, offset = 0 } = options;

    if (where) {
      for (const [k, v] of Object.entries(where)) {
        if (v === undefined) continue;
        rows = rows.filter((r) => r[k] === v);
      }
    }
    if (whereIn) {
      for (const [k, vals] of Object.entries(whereIn)) {
        if (!vals) continue;
        const set = new Set(vals as unknown[]);
        rows = rows.filter((r) => set.has(r[k]));
      }
    }
    if (gte) {
      for (const [k, v] of Object.entries(gte)) {
        if (v === undefined) continue;
        rows = rows.filter((r) => (r[k] as string | number) >= (v as string | number));
      }
    }
    if (lt) {
      for (const [k, v] of Object.entries(lt)) {
        if (v === undefined) continue;
        rows = rows.filter((r) => (r[k] as string | number) < (v as string | number));
      }
    }

    if (orderBy) {
      const k = orderBy as string;
      rows.sort((a, b) => {
        const av = a[k] as string | number;
        const bv = b[k] as string | number;
        if (av === bv) return 0;
        const cmp = av > bv ? 1 : -1;
        return direction === 'asc' ? cmp : -cmp;
      });
    }

    const sliced = rows.slice(offset, limit === undefined ? undefined : offset + limit);
    return sliced.map((r) => structuredClone(r)) as unknown as Tables[K][];
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
    const row = this.table(table).get(id);
    if (!row) throw notFound(table);
    await this.assertAccess(scope, table, row);
    const next = { ...row, ...(patch as Record<string, unknown>) } as Row;
    this.table(table).set(id, next);
    return structuredClone(next) as unknown as Tables[K];
  }

  async remove<K extends TableName>(scope: TenantScope, table: K, id: Uuid): Promise<void> {
    const row = this.table(table).get(id);
    if (!row) return;
    await this.assertAccess(scope, table, row);
    this.table(table).delete(id);
    if (table === 'projects') this.cascadeFromProject(id);
  }

  /**
   * Deletes everything hanging off a project, the way Postgres does.
   *
   * Every table that references `projects(id)` in the migration declares
   * `on delete cascade`, so under Supabase one delete clears all of it —
   * including the encrypted tokens. Without this the memory driver would leave
   * those rows behind, and the two drivers would disagree about what "delete
   * this project" means. They must not: it is the control the privacy policy
   * points at.
   */
  private cascadeFromProject(projectId: Uuid): void {
    for (const rows of this.tables.values()) {
      for (const [rowId, row] of rows) {
        if ((row as { project_id?: Uuid }).project_id === projectId) rows.delete(rowId);
      }
    }
  }

  async count<K extends TableName>(
    scope: TenantScope,
    table: K,
    options: QueryOptions<Tables[K]> = {},
  ): Promise<number> {
    const rows = await this.find(scope, table, { ...options, limit: undefined, offset: 0 });
    return rows.length;
  }

  async claimNextJob(
    now: string,
    lockTimeoutMs: number,
    opts: ClaimOptions = {},
  ): Promise<Job | null> {
    const { projectId, createdBefore } = opts;
    // Serialise claims so two concurrent workers cannot take the same job.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const prior = this.jobLock;
    this.jobLock = prior.then(() => gate);
    await prior;
    try {
      const staleBefore = new Date(Date.parse(now) - lockTimeoutMs).toISOString();
      const jobs = [...this.table('jobs').values()] as unknown as Job[];
      const candidate = jobs
        .filter(
          (j) =>
            (!projectId || j.project_id === projectId) &&
            (!createdBefore || j.created_at <= createdBefore) &&
            ((j.status === 'queued' && j.run_after <= now) ||
              (j.status === 'running' && j.locked_at !== null && j.locked_at < staleBefore)),
        )
        .sort((a, b) => (a.run_after < b.run_after ? -1 : a.run_after > b.run_after ? 1 : 0))[0];
      if (!candidate) return null;
      const claimed: Job = {
        ...candidate,
        status: 'running',
        locked_at: now,
        attempts: candidate.attempts + 1,
        updated_at: now,
        // Reclaiming a job whose worker died is the only record that it died:
        // the worker was killed before it could write anything itself.
        last_error:
          candidate.status === 'running'
            ? 'The previous attempt was cut off before it finished.'
            : candidate.last_error,
      };
      this.table('jobs').set(claimed.id, claimed as unknown as Row);
      return structuredClone(claimed);
    } finally {
      release();
    }
  }
}
