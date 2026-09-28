# a2a-pool-agent

Multi-marketplace autonomous agent for the A2A pool ecosystem.

The agent discovers tasks across multiple marketplaces (Railway, OKX,
Clustly, and future platforms), makes economic triage decisions based on
net profit margin, executes with a dynamic model router, delivers signed
results, and learns from every outcome.

## Status

**F1 — Structure & Types** (in progress)

- [x] Repository structure
- [x] Core type definitions
- [x] Adapter interface
- [ ] Core modules (triage, router, executor, quality, budget, ledger, ...)
- [ ] Railway adapter
- [ ] OKX adapter
- [ ] Clustly adapter
- [ ] Gateway (FastAPI)
- [ ] Migrations & store

See `docs/V1-SCOPE.md` for the full plan.

## Architecture

Read `docs/ARCHITECTURE.md` first. Then `docs/ADAPTERS.md` for the
adapter contract, `docs/ECONOMICS.md` for the triage formula, and
`docs/LEARNING.md` for the learning schema.

## Quick start

Prerequisites: Node 22+, pnpm 9+ / npm 10+.

```bash
cp .env.example .env
npm install
npm run build
npm start
```

## Production & Hardening (ETAPA 8)

### 1. How to Run in Production
- **Build**: `npm run build`
- **Start**: `npm start` (runs `node dist/index.js`)
- **Development**: `npm run dev` (hot-reloading via `tsx watch src/index.ts`)
- **Typecheck & Linter**: `npm run typecheck` / `npm run lint`
- **Test Suite**: `npm test`

### 2. Key Environment Variables
| Variable | Default | Description |
|---|---|---|
| `AGENT_ID` | `00000000-...` | Cryptographic UUID of the agent |
| `AGENT_ENVIRONMENT` | `production` | Environment tier (`development`, `staging`, `production`) |
| `CORE_PORT` | `3000` | Port for Dashboard, A2A endpoints, and health probes |
| `STATE_PERSISTENCE_DIR`| `./data/state` | Directory for atomic JSON state files (reputation, escrow, card history, telemetry) |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Maximum time to await in-flight task drain before forcing exit |
| `CIRCUIT_BREAKER_FAILURES` | `3` | Consecutive failures before tripping downstream circuit breakers |
| `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` | `30000` | Cooldown period before probing recovery in `HALF_OPEN` state |
| `A2A_RATE_LIMIT_PER_MINUTE` | `60` | Token bucket limit for inbound A2A requests |
| `RATCHET_MIN_DELTA` | `0.05` | Minimum quality/performance delta required by Ratchet to accept proposals |
| `DYNAMIC_PRICING_BASE_PRICE_USD` | `0.05` | Base floor price for tasks |
| `DYNAMIC_PRICING_MAX_HIKE_RATIO` | `0.10` | Maximum price hike allowed for high-reputation scores |
| `ENABLE_PROMETHEUS_METRICS` | `true` | Enables plain-text Prometheus exporter on `/metrics` |

### 3. Health & Readiness Endpoints
- **Liveness Probe**: `GET /health` (or `/api/health`)
  - Returns `200 OK` with JSON `{ status: "healthy", version: "1.0.0", uptimeSeconds: 360, environment: "production" }`
  - Returns `status: "draining"` when the agent is shutting down.
- **Readiness Probe**: `GET /ready` (or `/api/ready`)
  - Returns `200 OK` when critical dependencies (identity key, double-entry ledger balance, active adapters, and lifecycle) are operational.
  - Returns `503 Service Unavailable` if an adapter fails, ledger is imbalanced, or the agent is shutting down.
- **Prometheus Metrics**: `GET /metrics`
  - Standard Prometheus v0.0.4 text export for counters and gauges: `agent_tasks_total`, `agent_tasks_accepted`, `agent_system1_hit_rate`, `agent_avg_cost_usd`, `agent_ratchet_accepted_total`, `agent_tokens_consumed_total`.
- **JSON Metrics & Status**: `GET /api/metrics` and `GET /api/status`.

### 4. Version Rollback Procedures
- **Ratchet Immune System Auto-Rollback**:
  - The Ratchet immune system automatically benchmarks all candidate code (EvalPack). If a candidate degrades quality, increases latency by >20%, or violates zero-trust safety checks, Ratchet rejects the proposal and immediately rolls back to the previous stable tool version without downtime.
- **Dynamic Agent Card Rollback**:
  - The `DynamicAgentCardManager` keeps a tamper-evident audit history of all signed Agent Card versions.
  - Rollback to an earlier version or build number via API/code:
    ```ts
    const result = agentCore.dynamicCardManager.rollback("1.0.0"); // or build number
    // Automatically re-publishes and re-signs card at /.well-known/agent-card.json and updates PeerRegistry
    ```

### 5. Graceful Shutdown & Persistence
- Listens to `SIGTERM` and `SIGINT`.
- Sets state to draining (rejects new tasks with `503` / `agent_draining`).
- Awaits in-flight executions up to `SHUTDOWN_TIMEOUT_MS`.
- Flushes telemetry and writes atomic snapshots (`.tmp` write + atomic `rename`) for:
  - `reputation.json`
  - `escrow.json`
  - `agent-card-history.json`
  - `telemetry.json`
- Safely closes server and database connection pools.
