/**
 * Hourly snapshot.
 *
 * Prints a compact line suitable for cron logs.
 */

import 'dotenv/config';
import { Metrics } from '../src/observability/metrics.js';
import { closePool } from '../src/persistence/pool.js';

async function main(): Promise<void> {
  const m = new Metrics();
  const o = await m.overview(1 / 24);
  const ts = new Date().toISOString();
  console.log(
    ts +
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
