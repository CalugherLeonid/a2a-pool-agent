-- 002_learning.sql
-- Learning events: one row per task, capturing predicted vs actual.

CREATE TABLE IF NOT EXISTS learning_events (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  agent_id                    UUID NOT NULL,
  task_id                     VARCHAR(128) NOT NULL,
  adapter_id                  VARCHAR(64) NOT NULL,
  task_type                   VARCHAR(64) NOT NULL,
  strategy_id                 VARCHAR(64) NOT NULL,

  -- Prediction (triage BEFORE)
  predicted_cost_usd          NUMERIC(20, 8) NOT NULL,
  predicted_latency_s         NUMERIC(10, 2) NOT NULL,
  predicted_success_prob      NUMERIC(5, 4) NOT NULL,
  predicted_quality           NUMERIC(5, 4) NOT NULL,
  predicted_model             VARCHAR(64) NOT NULL,
  predicted_settlement_delay_h NUMERIC(10, 2) NOT NULL,

  -- Reality (AFTER)
  actual_cost_usd             NUMERIC(20, 8) NOT NULL,
  actual_latency_s            NUMERIC(10, 2) NOT NULL,
  actual_success              BOOLEAN NOT NULL,
  actual_quality              NUMERIC(5, 4) NOT NULL,
  actual_model                VARCHAR(64) NOT NULL,
  actual_provider             VARCHAR(32) NOT NULL,
  actual_settlement_delay_h   NUMERIC(10, 2) NOT NULL,
  actual_platform_fee_usd     NUMERIC(20, 8) NOT NULL DEFAULT 0,
  actual_gas_cost_usd         NUMERIC(20, 8) NOT NULL DEFAULT 0,

  -- Context
  budget_daily_used           NUMERIC(20, 8) NOT NULL DEFAULT 0,
  budget_daily_cap            NUMERIC(20, 8) NOT NULL DEFAULT 0,

  -- Outcome
  revenue_usd                 NUMERIC(20, 8) NOT NULL,
  profit_usd                  NUMERIC(20, 8) NOT NULL,
  time_adjusted_profit        NUMERIC(20, 8) NOT NULL,

  -- Signal
  error_kind                  VARCHAR(64),
  client_feedback             VARCHAR(16)
                                CHECK (client_feedback IN ('accepted', 'rejected', 'timeout', 'disputed')),

  ts                          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_le_task_type        ON learning_events(task_type);
CREATE INDEX IF NOT EXISTS idx_le_adapter          ON learning_events(adapter_id);
CREATE INDEX IF NOT EXISTS idx_le_model            ON learning_events(actual_model);
CREATE INDEX IF NOT EXISTS idx_le_ts               ON learning_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_le_task_adapter     ON learning_events(task_type, adapter_id);
CREATE INDEX IF NOT EXISTS idx_le_task_adapter_ts  ON learning_events(task_type, adapter_id, ts DESC);
