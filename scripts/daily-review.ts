/**
 * Daily review.
 *
 * Usage:
 *   pnpm tsx scripts/daily-review.ts
 *   pnpm tsx scripts/daily-review.ts 7
 *   AGENT_ENVIRONMENT=staging pnpm tsx scripts/daily-review.ts
 */

import 'dotenv/config';
import { Metrics } from '../src/observability/metrics.js';
import { closePool } from '../src/persistence/pool.js';
import { env } from '../src/config/env.js';

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function usd(n: number, digits = 4): string {
  return '$' + n.toFixed(digits);
}

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? '1');
  const m = new Metrics(env.AGENT_ENVIRONMENT);

  console.log('');
  console.log('='.repeat(72));
  console.log('  AGENT DAILY REVIEW  —  last ' + days + ' day(s)');
  console.log('  environment: ' + env.AGENT_ENVIRONMENT);
  console.log('  ' + new Date().toISOString());
  console.log('='.repeat(72));
  console.log('');

  const o = await m.overview(days);
  console.log('OVERVIEW');
  console.log('  tasks processed:      ' + o.totalTasks);
  console.log('  success rate:         ' + (o.successRate * 100).toFixed(2) + '%');
  console.log('  total revenue:        ' + usd(o.totalRevenueUsd));
  console.log('  total cost:           ' + usd(o.totalCostUsd, 8));
  console.log('  total profit:         ' + usd(o.totalProfitUsd));
  console.log('  avg profit / task:    ' + usd(o.avgProfitPerTaskUsd));
  console.log('  avg cost / task:      ' + usd(o.avgCostPerTaskUsd, 8));
  console.log('  avg latency:          ' + o.avgLatencyS.toFixed(3) + ' s');
  console.log('  ledger balanced:      ' + (o.ledgerBalanced ? 'YES' : 'NO'));
  console.log('');

  const types = await m.perTaskType(Math.max(days, 7));
  if (types.length > 0) {
    console.log('PER TASK TYPE (last 7d)');
    console.log(
      '  ' +
        pad('task', 12) +
        pad('tasks', 7) +
        pad('success', 10) +
        pad('avg cost', 14) +
        pad('avg profit', 14) +
        pad('latency', 10) +
        pad('model', 24),
    );
    for (const t of types) {
      console.log(
        '  ' +
          pad(t.taskType, 12) +
          pad(String(t.tasks), 7) +
          pad((t.successRate * 100).toFixed(1) + '%', 10) +
          pad(usd(t.avgCostUsd, 8), 14) +
          pad(usd(t.avgProfitUsd, 4), 14) +
          pad(t.avgLatencyS.toFixed(2) + 's', 10) +
          pad(t.dominantModel, 24),
      );
    }
    console.log('');
  }

  const providers = await m.perProvider(Math.max(days, 7));
  if (providers.length > 0) {
    console.log('PER PROVIDER (last 7d)');
    console.log(
      '  ' +
        pad('provider', 14) +
        pad('tasks', 7) +
        pad('success', 10) +
        pad('avg cost', 14) +
        pad('avg latency', 14),
    );
    for (const p of providers) {
      console.log(
        '  ' +
          pad(p.provider, 14) +
          pad(String(p.tasks), 7) +
          pad((p.successRate * 100).toFixed(1) + '%', 10) +
          pad(usd(p.avgCostUsd, 8), 14) +
          pad(p.avgLatencyS.toFixed(3) + 's', 14),
      );
    }
    console.log('');
  }

  const adapters = await m.perAdapter(Math.max(days, 7));
  if (adapters.length > 0) {
    console.log('PER ADAPTER (last 7d)');
    console.log(
      '  ' +
        pad('adapter', 14) +
        pad('tasks', 7) +
        pad('success', 10) +
        pad('revenue', 14) +
        pad('profit', 14) +
        pad('avg TAP', 12),
    );
    for (const a of adapters) {
      console.log(
        '  ' +
          pad(a.adapterId, 14) +
          pad(String(a.tasks), 7) +
          pad((a.successRate * 100).toFixed(1) + '%', 10) +
          pad(usd(a.totalRevenueUsd, 4), 14) +
          pad(usd(a.totalProfitUsd, 4), 14) +
          pad(usd(a.avgTimeAdjustedProfit, 2), 12),
      );
    }
    console.log('');
  }

  const alerts = await m.alerts();
  if (alerts.length === 0) {
    console.log('ALERTS: none  ✓');
  } else {
    console.log('ALERTS:');
    for (const a of alerts) {
      const icon =
        a.severity === 'critical' ? '✗' : a.severity === 'warn' ? '!' : 'i';
      console.log(
        '  [' +
          icon +
          '] ' +
          a.code +
          ' — ' +
          a.message +
          (a.value !== undefined ? ' (value=' + a.value + ')' : ''),
      );
    }
  }

  console.log('');
  console.log('='.repeat(72));
  console.log('');
}

main()
  .then(() => closePool())
  .catch((err) => {
    console.error('Review failed:', err);
    process.exit(1);
  });
