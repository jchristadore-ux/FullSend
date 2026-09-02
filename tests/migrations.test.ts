/**
 * The migration ledger and the file it is generated from.
 *
 * The server applies migrations from a generated module rather than from disk,
 * because a serverless function cannot count on the .sql files being beside
 * it. That copy is only trustworthy if it cannot drift from the files people
 * actually read and edit — which is what the first test here is for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readMigrations, renderModule } from '../scripts/build-migrations';
import { MIGRATIONS } from '@/lib/db/migration-sql.generated';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ORIGINAL_DB_URL = process.env.SUPABASE_DB_URL;
afterEach(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.SUPABASE_DB_URL;
  else process.env.SUPABASE_DB_URL = ORIGINAL_DB_URL;
  vi.resetModules();
});

describe('the baked-in migrations', () => {
  it('match the .sql files exactly', () => {
    /*
     * If this fails, someone edited a migration without regenerating:
     *   npm run build:migrations
     * Committing the two out of step would mean the file a person pastes and
     * the SQL the server runs are different statements under one name.
     */
    const current = renderModule(readMigrations());
    const committed = readFileSync(
      path.join(process.cwd(), 'src', 'lib', 'db', 'migration-sql.generated.ts'),
      'utf8',
    );
    expect(committed).toBe(current);
  });

  it('includes every migration, in filename order', () => {
    const files = readMigrations().map((m) => m.name);
    expect(MIGRATIONS.map((m) => m.name)).toEqual(files);
    expect([...files]).toEqual([...files].sort());
  });

  it('carries real SQL, not empty placeholders', () => {
    for (const migration of MIGRATIONS) {
      expect(migration.sql.trim().length).toBeGreaterThan(20);
      expect(migration.name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
  });

  /*
   * Every migration must be safe to run twice.
   *
   * The applier records what it ran, but a database migrated by hand before
   * that ledger existed has no record — so the first automated run may well
   * re-apply everything. That is only harmless if each file says so itself.
   */
  it('is written to be repeatable', () => {
    for (const migration of MIGRATIONS) {
      const sql = migration.sql;
      const creates = [...sql.matchAll(/create\s+(table|index|unique index)\s+(?!if not exists)/gi)];
      expect(creates.map((m) => `${migration.name}: ${m[0].trim()}`)).toEqual([]);

      // `create policy` has no IF NOT EXISTS, so each one needs a drop first.
      const policies = [...sql.matchAll(/create policy\s+(\S+)/gi)].map((m) => m[1]);
      for (const policy of policies) {
        expect(
          sql.includes(`drop policy if exists ${policy}`),
          `${migration.name}: policy ${policy} is created without a preceding drop`,
        ).toBe(true);
      }
    }
  });
});

/**
 * A connection that cannot be made is a report, not an exception.
 *
 * `migrationReport` throwing turned into a 500, and the Control Room card,
 * having nothing to render, drew nothing at all — the schema panel was simply
 * absent, with no way to tell "not configured" from "broken". A founder looking
 * for it concluded the feature did not exist.
 */
describe('reporting a database it cannot reach', () => {
  it('returns an unconnected report rather than throwing', async () => {
    // A syntactically valid URL pointing at nothing that will answer.
    process.env.SUPABASE_DB_URL = 'postgresql://u:p@127.0.0.1:1/none';
    vi.resetModules();
    const { migrationReport } = await import('@/lib/db/migrate');

    const report = await migrationReport();

    expect(report.connected).toBe(false);
    // And it says what to do about it, rather than only that it failed.
    expect(report.reason).toContain('Session pooler');
    // Every migration is still listed, so the panel renders in full.
    expect(report.migrations.length).toBe(MIGRATIONS.length);
    expect(report.pending).toEqual(MIGRATIONS.map((m) => m.name));
  }, 30_000);
});
