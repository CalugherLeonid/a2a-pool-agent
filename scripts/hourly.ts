/**
 * Hourly snapshot.
 *
 * Usage:
 *   pnpm tsx scripts/hourly.ts
 *   AGENT_ENVIRONMENT=staging pnpm tsx scripts/hourly.ts
 */

import 'dotenv/config';
import { Metrics } from '../src/observability/metrics.js';
import { closePool } from '../src/persistence/pool.js';
import { env } from '../src/config/env.js';

async function main(): Promise<void> {
  const m = new Metrics(env.AGENT_ENVIRONMENT);
  const o = await m.overview(1 / 24);
  const ts = new Date().toISOString();
  console.log(
    ts +
      ' | env=' +
      env.AGENT_ENVIRONMENT +
      ' | tasks=' +
      o.totalTasks +
      ' success=' +
      (o.successRate * 100).toFixed(1) +
      '% profit=$' +
      o.totalProfitUsd.toFixed(4) +
      ' cost=$' +
      o.totalCostUsd.toFixed(6) +
      ' ledger=' +
      (o.ledgerBalanced ? 'OK' : 'BAD'),
  );
}

main()
  .then(() => closePool())
  .catch((err) => {
    console.error('Hourly failed:', err);
    process.exit(1);
  });
