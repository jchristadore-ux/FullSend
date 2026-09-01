/**
 * Bakes the migration files into a module the server can read at runtime.
 *
 * The .sql files stay the source of truth — they are what a person pastes into
 * the SQL editor, and what the repository documents. But a serverless function
 * cannot rely on them being on disk beside it, so the applier reads this
 * generated copy instead.
 *
 * The copy is committed, and a test fails if it has drifted from the files, so
 * the two cannot quietly disagree about what migration 0003 contains.
 *
 *   npm run build:migrations
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase', 'migrations');
const OUT = path.join(process.cwd(), 'src', 'lib', 'db', 'migration-sql.generated.ts');

export interface MigrationFile {
  name: string;
  sql: string;
}

/** Every migration, in the order their filenames put them. */
export function readMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

export function renderModule(migrations: MigrationFile[]): string {
  const entries = migrations
    .map((m) => `  {\n    name: ${JSON.stringify(m.name)},\n    sql: ${JSON.stringify(m.sql)},\n  },`)
    .join('\n');

  return `/**
 * GENERATED FILE — do not edit.
 *
 * Written by scripts/build-migrations.ts from supabase/migrations/*.sql.
 * Regenerate with \`npm run build:migrations\`; a test fails if it is stale.
 */

export interface MigrationSource {
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly MigrationSource[] = [
${entries}
];
`;
}

if (process.argv[1] && process.argv[1].endsWith('build-migrations.ts')) {
  const migrations = readMigrations();
  writeFileSync(OUT, renderModule(migrations), 'utf8');
  console.log(`Wrote ${migrations.length} migrations to ${path.relative(process.cwd(), OUT)}`);
}
