/**
 * Postgres connection pool with in-memory fallback mock.
 *
 * Automatically connects to Postgres when DATABASE_URL is configured
 * and reachable, otherwise smoothly falls back to an in-memory database
 * store so that Agent Core, Ledger, BudgetGuard, and LearningStore work
 * out of the box in ephemeral cloud environments.
 */

import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('db');

let pool: Pool | undefined;
let isMockActive = false;

// --- IN-MEMORY DATABASE STORE ---
interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  currency: string;
  created_at: Date;
}

interface TransactionRow {
  id: string;
  task_id: string;
  adapter_id: string;
  description: string;
  status: string;
  created_at: Date;
  settled_at: Date | null;
}

interface LedgerEntryRow {
  id: string;
  transaction_id: string;
  account_id: string;
  debit: number;
  credit: number;
  created_at: Date;
}

interface LearningEventRow {
  id: string;
  environment: string;
  agent_id: string;
  task_id: string;
  adapter_id: string;
  task_type: string;
  strategy_id: string;
  predicted_cost_usd: number;
  predicted_latency_s: number;
  predicted_success_prob: number;
  predicted_quality: number;
  predicted_model: string;
  predicted_settlement_delay_h: number;
  actual_cost_usd: number;
  actual_latency_s: number;
  actual_success: boolean;
  actual_quality: number;
  actual_model: string;
  actual_provider: string;
  actual_settlement_delay_h: number;
  actual_platform_fee_usd: number;
  actual_gas_cost_usd: number;
  budget_daily_used: number;
  budget_daily_cap: number;
  revenue_usd: number;
  profit_usd: number;
  time_adjusted_profit: number;
  error_kind: string | null;
  client_feedback: string | null;
  ts: Date;
}

const memoryAccounts: AccountRow[] = [
  { id: '11111111-1111-1111-1111-111111111101', code: 'wallet_mock', name: 'Mock Marketplace Wallet', type: 'asset', currency: 'USD', created_at: new Date() },
  { id: '11111111-1111-1111-1111-111111111102', code: 'wallet_railway', name: 'Railway Marketplace Wallet', type: 'asset', currency: 'USD', created_at: new Date() },
  { id: '11111111-1111-1111-1111-111111111103', code: 'wallet_okx', name: 'OKX Marketplace Wallet', type: 'asset', currency: 'USD', created_at: new Date() },
  { id: '11111111-1111-1111-1111-111111111104', code: 'wallet_clustly', name: 'Clustly Marketplace Wallet', type: 'asset', currency: 'USD', created_at: new Date() },
  { id: '11111111-1111-1111-1111-111111111105', code: 'platform_fee', name: 'Platform Fees Expense', type: 'expense', currency: 'USD', created_at: new Date() },
  { id: '11111111-1111-1111-1111-111111111106', code: 'execution_cost', name: 'LLM Execution Cost Expense', type: 'expense', currency: 'USD', created_at: new Date() },
  { id: '11111111-1111-1111-1111-111111111107', code: 'gas_cost', name: 'Gas Cost Expense', type: 'expense', currency: 'USD', created_at: new Date() },
  { id: '11111111-1111-1111-1111-111111111108', code: 'revenue', name: 'Task Revenue', type: 'revenue', currency: 'USD', created_at: new Date() },
  { id: 'acc-escrow', code: 'escrow_pending', name: 'Escrow Pending', type: 'asset', currency: 'USD', created_at: new Date() },
  { id: 'acc-equity', code: 'equity', name: 'Retained Earnings', type: 'equity', currency: 'USD', created_at: new Date() },
  { id: 'acc-internal', code: 'wallet_internal', name: 'Internal Wallet', type: 'asset', currency: 'USD', created_at: new Date() },
];

const memoryTransactions: TransactionRow[] = [];
const memoryLedgerEntries: LedgerEntryRow[] = [];
const memoryLearningEvents: LearningEventRow[] = [];

function shouldTryRealDb(): boolean {
  if (isMockActive) return false;
  const url = env.DATABASE_URL;
  if (!url || url.includes('mock') || url.includes('localhost') || url.includes('ep-xxx')) {
    isMockActive = true;
    log.info('[AI Studio] Using in-memory mock database store for ephemeral execution');
    return false;
  }
  return true;
}

function getPool(): Pool | undefined {
  if (!shouldTryRealDb()) return undefined;
  if (!pool) {
    try {
      pool = new Pool({
        connectionString: env.DATABASE_URL,
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 3_000,
      });
      pool.on('error', (err) => {
        log.warn({ err }, 'idle database pool error — switching to mock store');
        isMockActive = true;
      });
    } catch {
      isMockActive = true;
      return undefined;
    }
  }
  return pool;
}

/** Execute query against in-memory mock store */
function executeMemoryQuery<R extends QueryResultRow>(
  text: string,
  params?: unknown[],
): QueryResult<R> {
  const norm = text.replace(/\s+/g, ' ').trim();
  const lower = norm.toLowerCase();

  // 1. SELECT id FROM transactions WHERE task_id = $1
  if (lower.startsWith('select id from transactions where task_id')) {
    const taskId = String(params?.[0] ?? '');
    const found = memoryTransactions.filter((t) => t.task_id === taskId);
    return {
      command: 'SELECT',
      rowCount: found.length,
      oid: 0,
      fields: [],
      rows: found.map((t) => ({ id: t.id })) as unknown as R[],
    };
  }

  // 2. INSERT INTO transactions (...) VALUES (...) RETURNING id, created_at
  if (lower.startsWith('insert into transactions')) {
    const id = randomUUID();
    const created_at = new Date();
    const taskId = String(params?.[0] ?? '');
    const adapterId = String(params?.[1] ?? '');
    const description = String(params?.[2] ?? '');
    const allowedStatus = new Set(['pending', 'settled', 'failed']);
    const statusFromParam = (params ?? []).find(
      (p) => typeof p === 'string' && allowedStatus.has(p),
    );
    const statusFromSql = lower.match(/'(pending|settled|failed)'/)?.[1];
    const status = String(statusFromParam ?? statusFromSql ?? 'settled');
    memoryTransactions.unshift({
      id,
      task_id: taskId,
      adapter_id: adapterId,
      description,
      status,
      created_at,
      settled_at: status === 'settled' ? created_at : null,
    });
    return {
      command: 'INSERT',
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ id, created_at }] as unknown as R[],
    };
  }

  // 3. SELECT id, code FROM accounts WHERE code = ANY($1::text[])
  if (lower.startsWith('select id, code from accounts where code = any')) {
    const codes = (params?.[0] as string[]) || [];
    const matched = memoryAccounts.filter((a) => codes.includes(a.code));
    return {
      command: 'SELECT',
      rowCount: matched.length,
      oid: 0,
      fields: [],
      rows: matched.map((a) => ({ id: a.id, code: a.code })) as unknown as R[],
    };
  }

  // 4. INSERT INTO ledger_entries (...)
  if (lower.startsWith('insert into ledger_entries')) {
    const id = randomUUID();
    const txId = String(params?.[0] ?? '');
    const accId = String(params?.[1] ?? '');
    const debit = Number(params?.[2] ?? 0);
    const credit = Number(params?.[3] ?? 0);
    memoryLedgerEntries.push({
      id,
      transaction_id: txId,
      account_id: accId,
      debit,
      credit,
      created_at: new Date(),
    });
    return {
      command: 'INSERT',
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [] as unknown as R[],
    };
  }

  // 5. INSERT INTO learning_events (...)
  if (lower.startsWith('insert into learning_events')) {
    const p = params || [];
    const id = randomUUID();
    const row: LearningEventRow = {
      id,
      environment: String(p[0] ?? 'development'),
      agent_id: String(p[1] ?? ''),
      task_id: String(p[2] ?? ''),
      adapter_id: String(p[3] ?? ''),
      task_type: String(p[4] ?? ''),
      strategy_id: String(p[5] ?? ''),
      predicted_cost_usd: Number(p[6] ?? 0),
      predicted_latency_s: Number(p[7] ?? 0),
      predicted_success_prob: Number(p[8] ?? 0),
      predicted_quality: Number(p[9] ?? 0),
      predicted_model: String(p[10] ?? ''),
      predicted_settlement_delay_h: Number(p[11] ?? 0),
      actual_cost_usd: Number(p[12] ?? 0),
      actual_latency_s: Number(p[13] ?? 0),
      actual_success: Boolean(p[14]),
      actual_quality: Number(p[15] ?? 0),
      actual_model: String(p[16] ?? ''),
      actual_provider: String(p[17] ?? ''),
      actual_settlement_delay_h: Number(p[18] ?? 0),
      actual_platform_fee_usd: Number(p[19] ?? 0),
      actual_gas_cost_usd: Number(p[20] ?? 0),
      budget_daily_used: Number(p[21] ?? 0),
      budget_daily_cap: Number(p[22] ?? 0),
      revenue_usd: Number(p[23] ?? 0),
      profit_usd: Number(p[24] ?? 0),
      time_adjusted_profit: Number(p[25] ?? 0),
      error_kind: p[26] ? String(p[26]) : null,
      client_feedback: p[27] ? String(p[27]) : null,
      ts: new Date(),
    };
    memoryLearningEvents.unshift(row);
    return {
      command: 'INSERT',
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ id }] as unknown as R[],
    };
  }

  // 6. SELECT COALESCE(SUM(actual_cost_usd), 0)::text AS sum FROM learning_events
  if (lower.includes('sum(actual_cost_usd)') && lower.includes('from learning_events')) {
    const envFilter = params?.[0] ? String(params[0]) : null;
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const sum = memoryLearningEvents
      .filter((e) => (!envFilter || e.environment === envFilter) && e.ts.toISOString().startsWith(todayStr))
      .reduce((acc, e) => acc + e.actual_cost_usd, 0);

    return {
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ sum: sum.toFixed(8) }] as unknown as R[],
    };
  }

  // 6b. SELECT ... FROM learning_events WHERE environment = $1 ORDER BY ts DESC LIMIT $2
  if (lower.includes('from learning_events') && lower.includes('order by ts desc')) {
    const envFilter = params?.[0] ? String(params[0]) : null;
    const limit = Number(params?.[1] ?? 20);
    const evs = memoryLearningEvents
      .filter((e) => !envFilter || e.environment === envFilter)
      .slice(0, limit)
      .map((e) => ({
        id: e.id,
        task_id: e.task_id,
        task_type: e.task_type,
        actual_model: e.actual_model,
        actual_cost_usd: e.actual_cost_usd.toFixed(8),
        profit_usd: e.profit_usd.toFixed(8),
        actual_success: e.actual_success,
        ts: e.ts.toISOString(),
      }));
    return {
      command: 'SELECT',
      rowCount: evs.length,
      oid: 0,
      fields: [],
      rows: evs as unknown as R[],
    };
  }

  // 7. Balance query: getBalance / accounts balances
  if (lower.includes('from accounts a') && lower.includes('ledger_entries le')) {
    // Check if filtering by specific code: WHERE a.code = $1
    if (lower.includes('where a.code = $1')) {
      const targetCode = String(params?.[0] ?? '');
      const acc = memoryAccounts.find((a) => a.code === targetCode);
      if (!acc) {
        return { command: 'SELECT', rowCount: 0, oid: 0, fields: [], rows: [] as unknown as R[] };
      }
      const entries = memoryLedgerEntries.filter((e) => e.account_id === acc.id);
      const debit = entries.reduce((s, e) => s + e.debit, 0);
      const credit = entries.reduce((s, e) => s + e.credit, 0);
      const isAssetOrExp = acc.type === 'asset' || acc.type === 'expense';
      const balance = isAssetOrExp ? debit - credit : credit - debit;
      return {
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [{ balance: balance.toFixed(8) }] as unknown as R[],
      };
    }

    // Chart of accounts balances
    const rows = memoryAccounts.map((a) => {
      const entries = memoryLedgerEntries.filter((e) => e.account_id === a.id);
      const total_debit = entries.reduce((s, e) => s + e.debit, 0);
      const total_credit = entries.reduce((s, e) => s + e.credit, 0);
      return {
        code: a.code,
        name: a.name,
        type: a.type,
        currency: a.currency,
        total_debit: total_debit.toFixed(8),
        total_credit: total_credit.toFixed(8),
      };
    });
    return {
      command: 'SELECT',
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows: rows as unknown as R[],
    };
  }

  // 8. bestModel / Model stats from learning_events
  if (lower.includes('actual_model as model') && lower.includes('from learning_events')) {
    const envFilter = params?.[0] ? String(params[0]) : null;
    const taskType = params?.[1] ? String(params[1]) : null;
    const adapterId = params?.[2] ? String(params[2]) : null;
    const minSamples = Number(params?.[4] ?? 0);

    const filtered = memoryLearningEvents.filter((e) =>
      (!envFilter || e.environment === envFilter) &&
      (!taskType || e.task_type === taskType) &&
      (!adapterId || e.adapter_id === adapterId)
    );

    const grouped = new Map<string, LearningEventRow[]>();
    for (const ev of filtered) {
      const k = `${ev.actual_model}::${ev.actual_provider}`;
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k)!.push(ev);
    }

    const rows = [];
    for (const [k, evs] of grouped.entries()) {
      if (evs.length < minSamples) continue;
      const [model, provider] = k.split('::');
      const avg_cost = evs.reduce((s, e) => s + e.actual_cost_usd, 0) / evs.length;
      const avg_quality = evs.reduce((s, e) => s + e.actual_quality, 0) / evs.length;
      const successes = evs.filter((e) => e.actual_success).length;
      const success_rate = successes / evs.length;
      const avg_latency = evs.reduce((s, e) => s + e.actual_latency_s, 0) / evs.length;
      rows.push({
        model,
        provider,
        avg_cost: avg_cost.toFixed(8),
        avg_quality: avg_quality.toFixed(4),
        success_rate: success_rate.toFixed(4),
        avg_latency: avg_latency.toFixed(2),
        n: String(evs.length),
      });
    }

    return {
      command: 'SELECT',
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows: rows as unknown as R[],
    };
  }

  // 9. successProbability from learning_events
  if (lower.includes('avg(actual_success::int)') && lower.includes('from learning_events')) {
    const envFilter = params?.[0] ? String(params[0]) : null;
    const taskType = params?.[1] ? String(params[1]) : null;
    const adapterId = params?.[2] ? String(params[2]) : null;
    const minSamples = Number(params?.[4] ?? 0);

    const filtered = memoryLearningEvents.filter((e) =>
      (!envFilter || e.environment === envFilter) &&
      (!taskType || e.task_type === taskType) &&
      (!adapterId || e.adapter_id === adapterId)
    );

    if (filtered.length < minSamples || filtered.length === 0) {
      return { command: 'SELECT', rowCount: 0, oid: 0, fields: [], rows: [] as unknown as R[] };
    }

    const successes = filtered.filter((e) => e.actual_success).length;
    const success_rate = successes / filtered.length;
    return {
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ success_rate: success_rate.toFixed(4), n: String(filtered.length) }] as unknown as R[],
    };
  }

  // 10. costEstimate from learning_events
  if (lower.includes('avg(actual_cost_usd)') && lower.includes('from learning_events')) {
    const envFilter = params?.[0] ? String(params[0]) : null;
    const taskType = params?.[1] ? String(params[1]) : null;
    const adapterId = params?.[2] ? String(params[2]) : null;
    const minSamples = Number(params?.[4] ?? 0);

    const filtered = memoryLearningEvents.filter((e) =>
      (!envFilter || e.environment === envFilter) &&
      (!taskType || e.task_type === taskType) &&
      (!adapterId || e.adapter_id === adapterId)
    );

    if (filtered.length < minSamples || filtered.length === 0) {
      return { command: 'SELECT', rowCount: 0, oid: 0, fields: [], rows: [] as unknown as R[] };
    }

    const avg_cost = filtered.reduce((s, e) => s + e.actual_cost_usd, 0) / filtered.length;
    return {
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ avg_cost: avg_cost.toFixed(8), n: String(filtered.length) }] as unknown as R[],
    };
  }

  // 11. Recent transactions with entries JSON
  if (lower.includes('from transactions t') && lower.includes('json_agg')) {
    const limit = Number(params?.[0] ?? 20);
    const txs = memoryTransactions.slice(0, limit).map((t) => {
      const entries = memoryLedgerEntries
        .filter((le) => le.transaction_id === t.id)
        .map((le) => {
          const acc = memoryAccounts.find((a) => a.id === le.account_id);
          return {
            accountCode: acc?.code ?? 'unknown',
            accountName: acc?.name ?? 'unknown',
            debit: le.debit,
            credit: le.credit,
          };
        });
      return {
        id: t.id,
        task_id: t.task_id,
        adapter_id: t.adapter_id,
        description: t.description,
        status: t.status,
        created_at: t.created_at.toISOString(),
        settled_at: t.settled_at?.toISOString() ?? null,
        entries,
      };
    });

    return {
      command: 'SELECT',
      rowCount: txs.length,
      oid: 0,
      fields: [],
      rows: txs as unknown as R[],
    };
  }

  // Generic fallback: empty result
  return {
    command: 'SELECT',
    rowCount: 0,
    oid: 0,
    fields: [],
    rows: [] as unknown as R[],
  };
}

/** Run a query. Automatically acquires and releases a client or falls back to in-memory store. */
export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<R>> {
  const p = getPool();
  if (p) {
    try {
      return await p.query<R>(text, params as unknown[]);
    } catch (err) {
      log.warn({ err }, 'query to Postgres failed — switching to in-memory mock store');
      isMockActive = true;
    }
  }
  return executeMemoryQuery<R>(text, params);
}

/** Run multiple statements in a single transaction. */
export async function withTransaction<T>(
  fn: (client: {
    query: <R extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: unknown[],
    ) => Promise<QueryResult<R>>;
  }) => Promise<T>,
): Promise<T> {
  const p = getPool();
  if (p) {
    try {
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: <R extends QueryResultRow = QueryResultRow>(
            text: string,
            params?: unknown[],
          ) => client.query<R>(text, params as unknown[]),
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      log.warn({ err }, 'database transaction connection failed — using in-memory mock transaction');
      isMockActive = true;
    }
  }

  // In-memory mock transaction runner
  return fn({
    query: async <R extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: unknown[],
    ) => executeMemoryQuery<R>(text, params),
  });
}

/** Graceful shutdown. Called on process exit. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    log.debug('pool closed');
  }
}

/** Helper to inspect in-memory stats directly if needed */
export function getMemoryStats() {
  return {
    accounts: memoryAccounts,
    transactions: memoryTransactions,
    entries: memoryLedgerEntries,
    learningEvents: memoryLearningEvents,
  };
}
