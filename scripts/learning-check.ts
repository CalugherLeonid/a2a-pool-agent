/**
 * Learning events overview.
 *
 * Usage:
 *   pnpm tsx scripts/learning-check.ts
 */

import 'dotenv/config';
import { LearningStore } from '../src/core/learning.js';
import { closePool } from '../src/persistence/pool.js';

async function main(): Promise<void> {
  const store = new LearningStore();

  const total = await store.count();
  console.log('');
  console.log('Total learning events: ' + total);

  console.log('');
  console.log('Best models per task type (adapter=mock, window=7d, min=3):');
  for (const taskType of ['extract', 'summarize', 'classify', 'transform']) {
    const models = await store.bestModel(taskType, 'mock', 7, 3);
    if (models.length === 0) {
      console.log('  ' + taskType.padEnd(12) + '(insufficient data)');
      continue;
    }
    const top = models[0]!;
    console.log(
      '  ' +
        taskType.padEnd(12) +
        '-> ' +
        top.model +
        '  success=' +
        top.successRate.toFixed(3) +
        '  avgCost=$' +
        top.avgCost.toFixed(8) +
        '  n=' +
        top.n,
    );
  }

  console.log('');
  console.log('Best adapter per task type (window=7d, min=3):');
  for (const taskType of ['extract', 'summarize', 'classify', 'transform']) {
    const adapters = await store.bestAdapter(taskType, 7, 3);
    if (adapters.length === 0) {
      console.log('  ' + taskType.padEnd(12) + '(insufficient data)');
      continue;
    }
    const top = adapters[0]!;
    console.log(
      '  ' +
        taskType.padEnd(12) +
        '-> ' +
        top.adapterId +
        '  avgProfit=$' +
        top.avgProfit.toFixed(4) +
        '  avgTAP=$' +
        top.avgTimeAdjustedProfit.toFixed(2) +
        '  n=' +
        top.n,
    );
  }

  console.log('');
  console.log('Calibration (predicted - actual):');
  const cal = await store.calibration(7, 3);
  if (cal.length === 0) {
    console.log('  (insufficient data)');
  } else {
    for (const c of cal) {
      console.log(
        '  ' +
          c.taskType.padEnd(12) +
          ' cost_bias=$' +
          c.costBias.toFixed(8) +
          '  quality_bias=' +
          c.qualityBias.toFixed(4) +
          '  latency_bias=' +
          c.latencyBias.toFixed(2) +
          's  n=' +
          c.n,
      );
    }
  }

  console.log('');
}

main()
  .then(() => closePool())
  .catch((err) => {
    console.error('Check failed:', err);
    process.exit(1);
  });
