/**
 * Double-entry ledger.
 *
 * Every financial event produces a transaction with N entries whose
 * debits equal credits. Balances are derived from entries — there is
 * no mutable balance column.
 *
 * Account types:
 *   asset     — debit increases, credit decreases
 *   expense   — debit increases, credit decreases
 *   liability — credit increases, debit decreases
 *   equity    — credit increases, debit decreases
 *   revenue   — credit increases, debit decreases
 *
 * For a completed task, one transaction is recorded:
 *
 *   DEBIT  wallet_<adapter>   net_revenue (revenue - fees - costs)
 *   DEBIT  platform_fee       platformFeeUsd
 *   DEBIT  execution_cost     executionCostUsd
 *   DEBIT  gas_cost           gasCostUsd
 *   CREDIT revenue            revenueUsd
 *
 * The sum of debits always equals the sum of credits.
 */

import { query, withTransaction } from '../persistence/pool.js';
import type { LedgerTransaction } from './types/index.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('ledger');

export interface TaskSettlementInput {
  taskId: string;
  adapterId: string;
  /** What the client paid. */
  revenueUsd: number;
  /** Platform fee kept by the marketplace. */
  platformFeeUsd: number;
  /** LLM execution cost paid by the agent. */
  executionCostUsd: number;
  /** On-chain gas cost. 0 in V1 for XLayer / mock. */
  gasCostUsd: number;
  /** Which wallet account received the net amount. */
  walletAccountCode?: string;
}

interface Entry {
  accountCode: string;
  debit: number;
  credit: number;
}

function walletCodeFor(adapterId: string): string {
  // Default per-adapter wallet, overridable by caller.
  const map: Record<string, string> = {
    mock: 'wallet_mock',
    railway: 'wallet_railway',
    okx: 'wallet_okx',
    clustly: 'wallet_clustly',
  };
  return map[adapterId] ?? 'wallet_internal';
}

export class Ledger {
  /**
   * Record a task settlement. Idempotent on task_id: if a transaction
   * already exists for the task, it is not recorded again.
   */
  async recordSettlement(
    input: TaskSettlementInput,
  ): Promise<LedgerTransaction | null> {
    const {
      taskId,
      adapterId,
      revenueUsd,
      platformFeeUsd,
      executionCostUsd,
      gasCostUsd,
    } = input;

    const walletCode = input.walletAccountCode ?? walletCodeFor(adapterId);

    // Idempotency check
    const existing = await query<{ id: string }>(
      'SELECT id FROM transactions WHERE task_id = $1 LIMIT 1',
      [taskId],
    );
    if (existing.rows.length > 0) {
      log.debug({ taskId }, 'settlement already recorded, skipping');
      return null;
    }

    // Build entries with rounding applied first
    const round8 = (n: number): number =>
      Math.round((n + Number.EPSILON) * 1e8) / 1e8;

    const entries: Entry[] = [];

    const roundedRevenue = round8(revenueUsd);
    const roundedPlatformFee = round8(platformFeeUsd);
    const roundedExecutionCost = round8(executionCostUsd);
    const roundedGasCost = round8(gasCostUsd);

    // revenue as credit
    entries.push({ accountCode: 'revenue', debit: 0, credit: roundedRevenue });

    // wallet as debit = revenue - fees - costs, adjusted for rounding
    const computedNet = round8(
      roundedRevenue - roundedPlatformFee - roundedExecutionCost - roundedGasCost,
    );

    if (computedNet > 0) {
      entries.push({ accountCode: walletCode, debit: computedNet, credit: 0 });
    }
    if (roundedPlatformFee > 0) {
      entries.push({
        accountCode: 'platform_fee',
        debit: roundedPlatformFee,
        credit: 0,
      });
    }
    if (roundedExecutionCost > 0) {
      entries.push({
        accountCode: 'execution_cost',
        debit: roundedExecutionCost,
        credit: 0,
      });
    }
    if (roundedGasCost > 0) {
      entries.push({
        accountCode: 'gas_cost',
        debit: roundedGasCost,
        credit: 0,
      });
    }

    // Verify balance using rounded values (same values we will persist)
    const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
    const totalCredit = entries.reduce((s, e) => s + e.credit, 0);
    const diff = Math.round((totalDebit - totalCredit) * 1e8) / 1e8;

    if (diff !== 0) {
      // Adjust the wallet entry (or the largest entry) by the residual
      const target = entries.find((e) => e.accountCode === walletCode && e.debit > 0);
      if (target) {
        target.debit = round8(target.debit - diff);
      } else if (diff < 0 && entries[0]) {
        // Fallback: adjust revenue credit
        entries[0].credit = round8(entries[0].credit + diff);
      }
    }

    // Final verify
    const finalDebit = entries.reduce((s, e) => s + e.debit, 0);
    const finalCredit = entries.reduce((s, e) => s + e.credit, 0);
    const finalDiff = Math.round((finalDebit - finalCredit) * 1e8) / 1e8;
    if (finalDiff !== 0) {
      throw new Error(
        'Ledger transaction not balanced after adjustment: debit=' +
          finalDebit +
          ' credit=' +
          finalCredit +
          ' diff=' +
          finalDiff,
      );
    }

    const netRevenueUsd = entries
      .filter((e) => e.accountCode === walletCode)
      .reduce((s, e) => s + e.debit, 0);

    // Write
    const tx = await withTransaction(async (txn) => {
      const txRow = await txn.query<{ id: string; created_at: Date }>(
        `INSERT INTO transactions (task_id, adapter_id, description, status, settled_at)
         VALUES ($1, $2, $3, 'settled', now())
         RETURNING id, created_at`,
        [taskId, adapterId, 'settlement for ' + taskId],
      );
      const txId = txRow.rows[0]!.id;

      // Look up account ids in a single query
      const codes = entries.map((e) => e.accountCode);
      const accRows = await txn.query<{ id: string; code: string }>(
        'SELECT id, code FROM accounts WHERE code = ANY($1::text[])',
        [codes],
      );
      const accMap = new Map(accRows.rows.map((r) => [r.code, r.id]));

      for (const e of entries) {
        const accId = accMap.get(e.accountCode);
        if (!accId) {
          throw new Error('Account not found: ' + e.accountCode);
        }
        await txn.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, debit, credit)
           VALUES ($1, $2, $3, $4)`,
          [txId, accId, e.debit.toFixed(8), e.credit.toFixed(8)],
        );
      }

      return { id: txId, createdAt: txRow.rows[0]!.created_at };
    });

    log.info(
      {
        taskId,
        adapterId,
        txId: tx.id,
        revenueUsd,
        netRevenueUsd,
        platformFeeUsd,
        executionCostUsd,
        gasCostUsd,
      },
      'settlement recorded',
    );

    return {
      id: tx.id,
      taskId,
      adapterId,
      description: 'settlement for ' + taskId,
      status: 'settled',
      entries: entries.map((e) => ({
        transactionId: tx.id,
        accountCode: e.accountCode,
        debit: e.debit,
        credit: e.credit,
      })),
      createdAt: tx.createdAt.toISOString(),
      settledAt: tx.createdAt.toISOString(),
    };
  }

  /** Current balance of an account, computed from entries. */
  async getBalance(accountCode: string): Promise<number> {
    const res = await query<{ balance: string }>(
      `SELECT
         COALESCE(SUM(
           CASE
             WHEN a.type IN ('asset', 'expense') THEN le.debit - le.credit
             ELSE le.credit - le.debit
           END
         ), 0)::text AS balance
       FROM accounts a
       LEFT JOIN ledger_entries le ON le.account_id = a.id
       WHERE a.code = $1
       GROUP BY a.code`,
      [accountCode],
    );
    return Number(res.rows[0]?.balance ?? 0);
  }

  /** Sum of all debits minus sum of all credits. Should always be 0. */
  async verifyIntegrity(): Promise<{
    balanced: boolean;
    totalDebit: number;
    totalCredit: number;
    imbalancedTxIds: string[];
  }> {
    const res = await query<{
      tx_id: string;
      total_debit: string;
      total_credit: string;
    }>(
      `SELECT
         transaction_id::text AS tx_id,
         SUM(debit)::text      AS total_debit,
         SUM(credit)::text     AS total_credit
       FROM ledger_entries
       GROUP BY transaction_id`,
    );

    const imbalanced: string[] = [];
    let totalDebit = 0;
    let totalCredit = 0;

    for (const row of res.rows) {
      const d = Number(row.total_debit);
      const c = Number(row.total_credit);
      totalDebit += d;
      totalCredit += c;
      if (Math.abs(d - c) > 1e-9) imbalanced.push(row.tx_id);
    }

    return {
      balanced: imbalanced.length === 0,
      totalDebit,
      totalCredit,
      imbalancedTxIds: imbalanced,
    };
  }

  /** Sum of profit (revenue - expenses) recorded since a given time. */
  async getProfitSince(since: Date): Promise<number> {
    const res = await query<{ profit: string }>(
      `SELECT COALESCE(
         SUM(
           CASE
             WHEN a.type = 'revenue' THEN le.credit - le.debit
             WHEN a.type = 'expense' THEN -1 * (le.debit - le.credit)
             ELSE 0
           END
         ), 0)::text AS profit
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
       JOIN transactions t ON t.id = le.transaction_id
       WHERE t.created_at >= $1`,
      [since.toISOString()],
    );
    return Number(res.rows[0]?.profit ?? 0);
  }

  /** All accounts with debits, credits, and net balances. */
  async getAccountBalances(): Promise<Array<{
    code: string;
    name: string;
    type: string;
    currency: string;
    totalDebit: number;
    totalCredit: number;
    balance: number;
  }>> {
    const res = await query<{
      code: string;
      name: string;
      type: string;
      currency: string;
      total_debit: string;
      total_credit: string;
    }>(
      `SELECT a.code, a.name, a.type, a.currency,
              COALESCE(SUM(le.debit), 0)::text AS total_debit,
              COALESCE(SUM(le.credit), 0)::text AS total_credit
       FROM accounts a
       LEFT JOIN ledger_entries le ON le.account_id = a.id
       GROUP BY a.id, a.code, a.name, a.type, a.currency
       ORDER BY a.code`,
    );
    return res.rows.map((r) => {
      const d = Number(r.total_debit);
      const c = Number(r.total_credit);
      const isAssetOrExp = r.type === 'asset' || r.type === 'expense';
      const balance = isAssetOrExp ? d - c : c - d;
      return {
        code: r.code,
        name: r.name,
        type: r.type,
        currency: r.currency,
        totalDebit: d,
        totalCredit: c,
        balance,
      };
    });
  }

  /** Recent settled transactions with aggregated entries. */
  async getRecentTransactions(limit = 20): Promise<Array<{
    id: string;
    task_id: string;
    adapter_id: string;
    description: string;
    status: string;
    created_at: string;
    settled_at: string | null;
    entries?: Array<{ accountCode: string; accountName: string; debit: number; credit: number }>;
  }>> {
    const res = await query<{
      id: string;
      task_id: string;
      adapter_id: string;
      description: string;
      status: string;
      created_at: string;
      settled_at: string | null;
      entries: Array<{ accountCode: string; accountName: string; debit: number; credit: number }>;
    }>(
      `SELECT t.id, t.task_id, t.adapter_id, t.description, t.status, t.created_at::text, t.settled_at::text,
              json_agg(json_build_object(
                'accountCode', a.code,
                'accountName', a.name,
                'debit', le.debit,
                'credit', le.credit
              )) AS entries
       FROM transactions t
       JOIN ledger_entries le ON le.transaction_id = t.id
       JOIN accounts a ON a.id = le.account_id
       GROUP BY t.id
       ORDER BY t.created_at DESC
       LIMIT $1`,
      [limit],
    );
    return res.rows;
  }
}
