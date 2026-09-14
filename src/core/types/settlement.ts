import type {
  ChainId,
  CurrencyCode,
  SettlementStatus,
  Usd,
} from './primitives.js';

/**
 * What an adapter returns after a successful delivery.
 *
 * IMPORTANT: `amount`, `platformFeeAmount` and `netAmount` are in the
 * platform's native currency. `amountUsd` and `netAmountUsd` are the
 * USD-normalized equivalents computed by the adapter — the only values
 * Agent Core uses for accounting.
 */
export interface SettlementReceipt {
  taskId: string;
  adapterId: string;
  currency: CurrencyCode;
  amount: number;
  amountUsd: Usd;
  platformFeePct: number;
  platformFeeAmount: number;
  netAmount: number;
  netAmountUsd: Usd;
  chain?: ChainId;
  txHash?: string;
  internalId?: string;
  status: SettlementStatus;
  settledAt?: string;
}

/**
 * A single side of a double-entry ledger transaction.
 * Exactly one of `debit` / `credit` is positive (enforced in DB).
 */
export interface LedgerEntry {
  transactionId: string;
  accountCode: string;
  debit: number;
  credit: number;
}

export interface LedgerTransaction {
  id: string;
  taskId: string;
  adapterId: string;
  description: string;
  status: 'pending' | 'settled' | 'failed';
  entries: LedgerEntry[];
  createdAt: string;
  settledAt?: string;
}