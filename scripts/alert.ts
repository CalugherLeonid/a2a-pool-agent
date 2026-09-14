/**
 * Alert check.
 *
 * Runs the alert rules and exits with code 1 if any critical alert
 * is present. Suitable for use in cron jobs.
 *
 * Usage:
 *   pnpm tsx scripts/alert.ts
 *
 * Exit codes:
 *   0  — no critical alerts
 *   1  — one or more critical alerts
 */

import 'dotenv/config';
import { Metrics } from '../src/observability/metrics.js';
import { closePool } from '../src/persistence/pool.js';

async function main(): Promise<void> {
  const m = new Metrics();
  const alerts = await m.alerts();

  if (alerts.length === 0) {
    console.log('OK — no alerts');
    process.exit(0);
  }

  const critical = alerts.filter((a) => a.severity === 'critical');
  const warn = alerts.filter((a) => a.severity === 'warn');

  for (const a of alerts) {
    const prefix =
      a.severity === 'critical' ? 'CRITICAL' : a.severity === 'warn' ? 'WARN' : 'INFO';
    console.log(
      prefix +
        ' ' +
        a.code +
        ': ' +
        a.message +
        (a.value !== undefined ? ' (value=' + a.value + ')' : ''),
    );
  }

  console.log('');
  console.log('Summary: ' + critical.length + ' critical, ' + warn.length + ' warn');
  process.exit(critical.length > 0 ? 1 : 0);
}

main()
  .then(() => closePool())
  .catch((err) => {
    console.error('Alert check failed:', err);
    process.exit(2);
  });
