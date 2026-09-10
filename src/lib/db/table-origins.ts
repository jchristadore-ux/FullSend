/**
 * Which migration creates which table.
 *
 * The remedy for a missing table used to be "run 0001_fullsend_init.sql",
 * whatever the table was. For every table 0001 creates that is true; for one
 * added by a later migration it is confidently wrong, and it costs whoever is
 * reading it the whole diagnosis. `website_sources` arrives in 0007, so a
 * founder whose analysis died on it was told to run a migration that would not
 * have created it, and the real fix — one pending migration — stayed invisible
 * behind an error that looked like a broken database.
 *
 * Kept as plain data rather than parsed out of the migration SQL, because this
 * is read on the failure path of a driver that every route loads and the SQL is
 * a large string constant no successful request should carry. `table-origins`
 * is checked against the real migrations by tests/pending-migration.test.ts, so
 * a table added tomorrow without an entry here fails there rather than lying
 * here.
 */

/** The migration that creates everything not listed below. */
export const INITIAL_MIGRATION = '0001_fullsend_init.sql';

/** Tables introduced after the initial schema. */
export const LATER_TABLES: Readonly<Record<string, string>> = {
  website_sources: '0007_website_source.sql',
};

/** The migration file that creates `table`. */
export function migrationCreating(table: string): string {
  return LATER_TABLES[table] ?? INITIAL_MIGRATION;
}

/** What to tell someone whose database does not have `table` yet. */
export function migrationRemedy(table: string): string {
  const migration = migrationCreating(table);
  if (migration === INITIAL_MIGRATION) {
    return (
      `Run supabase/migrations/${INITIAL_MIGRATION} in the Supabase SQL Editor. ` +
      'It creates every table and the rules that keep tenants separate.'
    );
  }
  return (
    `The \`${table}\` table is created by supabase/migrations/${migration}, which this ` +
    'database has not run yet. Apply it in the Control Room → Schema ("Apply pending ' +
    'migrations"), or paste that file into the Supabase SQL Editor. Nothing is lost — ' +
    'the work that needs this table can be retried once it exists.'
  );
}
