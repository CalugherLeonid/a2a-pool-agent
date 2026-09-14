-- 001_ledger.sql
-- Double-entry ledger: accounts, transactions, ledger_entries.
-- Plus seed accounts for the internal chart of accounts.

-- -----------------------------------------------------------------
-- Accounts
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         VARCHAR(64) UNIQUE NOT NULL,
  name         VARCHAR(128) NOT NULL,
  type         VARCHAR(16) NOT NULL
                 CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  currency     VARCHAR(16) NOT NULL DEFAULT 'USD',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------
-- Transactions
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      VARCHAR(128) NOT NULL,
  adapter_id   VARCHAR(64) NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       VARCHAR(16) NOT NULL DEFAULT 'settled'
                 CHECK (status IN ('pending', 'settled', 'failed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_transactions_task_id
  ON transactions(task_id);

CREATE INDEX IF NOT EXISTS idx_transactions_adapter_id
  ON transactions(adapter_id);

-- -----------------------------------------------------------------
-- Ledger entries
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id      UUID NOT NULL REFERENCES accounts(id),
  debit           NUMERIC(20, 8) NOT NULL DEFAULT 0,
  credit          NUMERIC(20, 8) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entry_one_side_only CHECK (
    (debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_tx
  ON ledger_entries(transaction_id);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_account
  ON ledger_entries(account_id);

-- -----------------------------------------------------------------
-- Seed accounts (idempotent)
-- -----------------------------------------------------------------
INSERT INTO accounts (code, name, type) VALUES
  ('revenue',        'Revenue',                'revenue'),
  ('execution_cost', 'LLM Execution Cost',     'expense'),
  ('gas_cost',       'On-chain Gas Cost',      'expense'),
  ('platform_fee',   'Platform Fee',           'expense'),
  ('equity',         'Retained Earnings',      'equity'),
  ('escrow_pending', 'Escrow Pending',         'asset'),
  ('wallet_internal','Internal Wallet',        'asset'),
  ('wallet_mock',    'Mock Wallet',            'asset'),
  ('wallet_railway', 'Railway Wallet',         'asset'),
  ('wallet_okx',     'OKX Wallet',             'asset'),
  ('wallet_clustly', 'Clustly Wallet',         'asset')
ON CONFLICT (code) DO NOTHING;
