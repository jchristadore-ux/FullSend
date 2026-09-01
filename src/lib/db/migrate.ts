/**
 * Applying migrations without a person in the loop.
 *
 * Until now every schema change ended the same way: someone opens the Supabase
 * SQL editor, copies a file out of the repository, pastes it in, and presses
 * Run. That step cannot be delegated, cannot be tested, and is invisible when
 * it is skipped — which is how a deployment ends up running code whose columns
 * do not exist yet.
 *
 * The service-role key cannot do this: PostgREST speaks tables, not DDL. What
 * it takes is a Postgres connection, which means one credential — SUPABASE_DB_URL —
 * added once. After that FullSend can see which migrations its database is
 * missing and apply them itself.
 *
 * Three deliberate limits:
 *
 *   • Nothing runs on boot or on deploy. Applying schema changes as a side
 *     effect of a deployment is how people lose data at 3am; it takes an
 *     explicit request from an admin.
 *   • Each migration runs inside its own transaction and is recorded in the
 *     same transaction, so a failure leaves neither a half-applied schema nor
 *     a false record of success.
 *   • A migration whose file has changed since it was applied is reported, not
 *     silently re-run. Editing an applied migration is a mistake, and the only
 *     useful thing to do about it is say so.
 */
import 'server-only';
import { createHash } from 'node:crypto';
import { env } from '../env';
import { FullSendError } from '../errors';
import { logger } from '../logger';
import { MIGRATIONS } from './migration-sql.generated';

const log = logger('migrate');

/** Where the applied set is recorded. Created on first use. */
const LEDGER = 'public.fullsend_migrations';

const LEDGER_DDL = `
create table if not exists ${LEDGER} (
  name text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
)`;

export interface MigrationState {
  name: string;
  applied: boolean;
  appliedAt: string | null;
  /** True when the file no longer matches what was applied under this name. */
  changedSinceApplied: boolean;
}

export interface MigrationReport {
  /** False when SUPABASE_DB_URL is unset — everything below is then unknown. */
  connected: boolean;
  reason?: string;
  migrations: MigrationState[];
  pending: string[];
  changed: string[];
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

function notConfigured(): MigrationReport {
  return {
    connected: false,
    reason:
      'SUPABASE_DB_URL is not set, so FullSend cannot apply migrations itself. ' +
      'Supabase → Project Settings → Database → Connection string → Session pooler. ' +
      'Until it is set, run the files by hand in the SQL editor.',
    migrations: MIGRATIONS.map((m) => ({
      name: m.name,
      applied: false,
      appliedAt: null,
      changedSinceApplied: false,
    })),
    pending: MIGRATIONS.map((m) => m.name),
    changed: [],
  };
}

/**
 * A Postgres client, loaded only when there is a connection string to use.
 *
 * Required lazily so a deployment with no SUPABASE_DB_URL — every deployment
 * before this feature — never pulls the driver into a serverless bundle it has
 * no use for.
 */
async function connect() {
  const url = env.supabase.dbUrl;
  if (!url) return null;
  const { Client } = require('pg') as typeof import('pg');
  const client = new Client({
    connectionString: url,
    // Supabase terminates TLS with its own chain; verifying it needs the CA
    // bundle, which is not worth a second credential for a connection that
    // never leaves the provider's network.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000,
  });
  await client.connect();
  return client;
}

/** What this database has, and what it is missing. */
export async function migrationReport(): Promise<MigrationReport> {
  const client = await connect();
  if (!client) return notConfigured();

  try {
    await client.query(LEDGER_DDL);
    const { rows } = await client.query<{ name: string; checksum: string; applied_at: Date }>(
      `select name, checksum, applied_at from ${LEDGER}`,
    );
    const byName = new Map(rows.map((r) => [r.name, r]));

    const migrations: MigrationState[] = MIGRATIONS.map((m) => {
      const record = byName.get(m.name);
      return {
        name: m.name,
        applied: Boolean(record),
        appliedAt: record ? new Date(record.applied_at).toISOString() : null,
        changedSinceApplied: Boolean(record && record.checksum !== checksum(m.sql)),
      };
    });

    return {
      connected: true,
      migrations,
      pending: migrations.filter((m) => !m.applied).map((m) => m.name),
      changed: migrations.filter((m) => m.changedSinceApplied).map((m) => m.name),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
  failed: { name: string; error: string } | null;
}

/**
 * Runs everything this database has not recorded, oldest first.
 *
 * Stops at the first failure rather than pressing on: migrations after a
 * failed one generally assume it succeeded, and running them anyway turns one
 * legible error into several confusing ones.
 */
export async function applyPendingMigrations(): Promise<ApplyResult> {
  const client = await connect();
  if (!client) {
    throw new FullSendError('db_url_missing', 'FullSend cannot reach the database directly', {
      retryable: false,
      remedy: notConfigured().reason ?? null,
    });
  }

  const result: ApplyResult = { applied: [], skipped: [], failed: null };

  try {
    await client.query(LEDGER_DDL);
    const { rows } = await client.query<{ name: string }>(`select name from ${LEDGER}`);
    const done = new Set(rows.map((r) => r.name));

    for (const migration of MIGRATIONS) {
      if (done.has(migration.name)) {
        result.skipped.push(migration.name);
        continue;
      }

      try {
        await client.query('begin');
        await client.query(migration.sql);
        await client.query(`insert into ${LEDGER} (name, checksum) values ($1, $2)`, [
          migration.name,
          checksum(migration.sql),
        ]);
        await client.query('commit');
        result.applied.push(migration.name);
        log.info('migration applied', { name: migration.name });
      } catch (e) {
        await client.query('rollback').catch(() => {});
        const message = e instanceof Error ? e.message : String(e);
        result.failed = { name: migration.name, error: message };
        log.error('migration failed', { name: migration.name, error: message });
        break;
      }
    }

    return result;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Records every migration as applied without running any of them.
 *
 * For a database that was migrated by hand before this existed: the schema is
 * already correct, and the only thing missing is the ledger saying so. Running
 * them again would work — every migration here is written to be repeatable —
 * but recording the truth is better than relying on that.
 */
export async function baselineMigrations(): Promise<{ recorded: string[] }> {
  const client = await connect();
  if (!client) {
    throw new FullSendError('db_url_missing', 'FullSend cannot reach the database directly', {
      retryable: false,
      remedy: notConfigured().reason ?? null,
    });
  }

  try {
    await client.query(LEDGER_DDL);
    const recorded: string[] = [];
    for (const migration of MIGRATIONS) {
      const { rowCount } = await client.query(
        `insert into ${LEDGER} (name, checksum) values ($1, $2) on conflict (name) do nothing`,
        [migration.name, checksum(migration.sql)],
      );
      if (rowCount) recorded.push(migration.name);
    }
    log.info('migrations baselined', { recorded: recorded.length });
    return { recorded };
  } finally {
    await client.end().catch(() => {});
  }
}
