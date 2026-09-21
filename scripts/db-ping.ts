/**
 * Verifies connectivity to the Neon Postgres instance.
 *
 * Usage:
 *   pnpm db:ping
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { Client } from 'pg';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  const res = await client.query<{ now: Date; version: string }>(
    'SELECT now() AS now, version() AS version',
  );

  const row = res.rows[0];
  console.log('DB is reachable.');
  console.log('  now:    ', row?.now);
  console.log('  version:', row?.version.split(' ').slice(0, 2).join(' '));

  await client.end();
}

main().catch((err: unknown) => {
  console.error('DB ping failed:', err);
  process.exit(1);
});
