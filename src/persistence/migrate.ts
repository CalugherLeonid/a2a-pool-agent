/**
 * Migration runner.
 *
 * Applies SQL files from `migrations/` in alphabetical order. Each file
 * is executed once and recorded in the `schema_migrations` table.
 *
 * The runner creates `schema_migrations` on its first run.
 *
 * Files must be idempotent-friendly (use IF NOT EXISTS etc.) so that
 * accidental re-runs are safe.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query, withTransaction } from './pool.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('migrate');

const MIGRATIONS_DIR = 'migrations';

interface MigrationFile {
  name: string;
  fullPath: string;
}

async function ensureSchemaMigrationsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        VARCHAR(255) PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles(): Promise<MigrationFile[]> {
  const dir = join(process.cwd(), MIGRATIONS_DIR);
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, fullPath: join(dir, name) }));
}

async function appliedNames(): Promise<Set<string>> {
  const res = await query<{ name: string }>('SELECT name FROM schema_migrations');
  return new Set(res.rows.map((r) => r.name));
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(): Promise<MigrateResult> {
  await ensureSchemaMigrationsTable();

  const files = await listMigrationFiles();
  const applied = await appliedNames();

  const result: MigrateResult = { applied: [], skipped: [] };

  for (const file of files) {
    if (applied.has(file.name)) {
      result.skipped.push(file.name);
      continue;
    }

    const sql = await readFile(file.fullPath, 'utf8');
    log.info({ name: file.name }, 'applying migration');

    await withTransaction(async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
        file.name,
      ]);
    });

    result.applied.push(file.name);
    log.info({ name: file.name }, 'applied');
  }

  return result;
}
