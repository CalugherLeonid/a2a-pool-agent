-- 003_environment.sql
-- Adauga un tag de environment pe learning_events ca sa nu se amestece
-- datele de simulare (mock) cu datele reale (railway/okx/clustly).
-- Randurile existente primesc default 'development' pentru ca au fost
-- produse de mock adapter.

ALTER TABLE learning_events
  ADD COLUMN IF NOT EXISTS environment VARCHAR(32) NOT NULL DEFAULT 'development';

CREATE INDEX IF NOT EXISTS idx_le_environment
  ON learning_events(environment);

CREATE INDEX IF NOT EXISTS idx_le_env_task_adapter
  ON learning_events(environment, task_type, adapter_id);
