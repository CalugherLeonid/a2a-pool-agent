/**
 * Ledger integrity check.
 *
 * Usage:
 *   pnpm tsx scripts/ledger-check.ts
 */

import 'dotenv/config';
import { Ledger } from '../src/core/ledger.js';
import { closePool } from '../src/persistence/pool.js';

async function main(): Promise<void> {
  const ledger = new Ledger();

  const integrity = await ledger.verifyIntegrity();
  console.log('');
  console.log('Ledger integrity');
  console.log('  balanced:      ' + integrity.balanced);
  console.log('  total debit:   $' + integrity.totalDebit.toFixed(8));
  console.log('  total credit:  $' + integrity.totalCredit.toFixed(8));
  if (integrity.imbalancedTxIds.length > 0) {
    console.log('  imbalanced:    ' + integrity.imbalancedTxIds.join(', '));
  }

  const balances = [
    'revenue',
    'execution_cost',
    'platform_fee',
    'gas_cost',
    'wallet_mock',
    'wallet_internal',
  ];
  console.log('');
  console.log('Account balances');
  for (const code of balances) {
    const b = await ledger.getBalance(code);
    console.log('  ' + code.padEnd(18) + ' $' + b.toFixed(8));
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const profit = await ledger.getProfitSince(today);
  console.log('');
  console.log('Profit today: $' + profit.toFixed(8));
  console.log('');
}

main()
  .then(() => closePool())
  .catch((err) => {
    console.error('Check failed:', err);
    process.exit(1);
  });
