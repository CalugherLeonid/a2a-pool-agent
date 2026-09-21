/**
 * Migration CLI.
 *
 * Usage:
 *   pnpm migrate
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { runMigrations } from '../src/persistence/migrate.js';
import { closePool } from '../src/persistence/pool.js';

async function main(): Promise<void> {
  const result = await runMigrations();

  console.log('');
  console.log('Migrations complete.');
  console.log('  applied: ' + result.applied.length);
  console.log('  skipped: ' + result.skipped.length);

  if (result.applied.length > 0) {
    console.log('');
    console.log('Applied:');
    for (const name of result.applied) console.log('  + ' + name);
  }
  if (result.skipped.length > 0) {
    console.log('');
    console.log('Already applied:');
    for (const name of result.skipped) console.log('  · ' + name);
  }
  console.log('');
}

main()
  .then(() => closePool())
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
