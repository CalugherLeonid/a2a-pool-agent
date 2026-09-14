/**
 * Smoke test for the Railway adapter.
 *
 * Verifies connectivity to the pool: register, poll once, print what
 * came back. Does NOT accept, deliver, or mutate anything.
 *
 * Usage:
 *   pnpm tsx scripts/railway-smoke.ts
 */

import 'dotenv/config';
import { env } from '../src/config/env.js';
import { RailwayClient } from '../src/adapters/railway/client.js';

async function main(): Promise<void> {
  console.log('Railway smoke test');
  console.log('  url:      ', env.RAILWAY_POOL_URL ?? '(unset)');
  console.log('  workerId: ', env.RAILWAY_WORKER_ID ?? '(unset)');
  console.log('');

  if (!env.RAILWAY_POOL_URL || !env.RAILWAY_WORKER_ID) {
    console.error(
      'RAILWAY_POOL_URL and RAILWAY_WORKER_ID must be set in .env',
    );
    process.exit(1);
  }

  const client = new RailwayClient(
    env.RAILWAY_POOL_URL,
    env.RAILWAY_WORKER_ID,
  );

  console.log('1. Register');
  try {
    await client.register();
    console.log('   ✓ registered');
  } catch (err) {
    console.log('   ✗ failed:', (err as Error).message);
  }

  console.log('');
  console.log('2. Poll once');
  try {
    const tasks = await client.poll();
    console.log('   ✓ poll returned', tasks.length, 'task(s)');
    if (tasks.length > 0) {
      console.log('   first task:');
      console.log(JSON.stringify(tasks[0], null, 2));
    }
  } catch (err) {
    console.log('   ✗ failed:', (err as Error).message);
  }

  console.log('');
  console.log('Done.');
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
