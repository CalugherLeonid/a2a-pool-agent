# A2A Pool Agent

Autonomous multi-marketplace and Agent-to-Agent (A2A) economic agent built with TypeScript.

## Overview

**A2A Pool Agent** is a sovereign autonomous agent architecture featuring a dual-engine execution model:

- **System 1 (Deterministic Fast Path):** Low-latency execution for known, deterministic tasks and local meta-tools without incurring unnecessary LLM or external network overhead.
- **System 2 (Deep Path & A2A Orchestration):** Deep reasoning, Hierarchical Task Network (HTN) goal decomposition, model routing (Gemini, Groq, OpenRouter), and Agent-to-Agent (A2A) peer delegation.

The agent operates with an integrated economic and trust layer:
- **Zero-Trust Identity:** Ed25519 cryptographic request/response signing and dynamic, signed Agent Cards (`.well-known/agent-card.json`).
- **M2M Economy:** Decentralized escrow contracts, dynamic pricing engines, double-entry bookkeeping (`Ledger`), and historical peer reputation scoring.
- **Continuous Discovery & Gating:** Background `OpportunityScanner` continuously ingests tasks from marketplaces and external feeds, passing every job through a quantitative `EconomicBrain` before committing compute.
- **Resilient Evolution:** The **Morphling Loop** and **Ratchet Immune System** dynamically re-plan tasks in flight upon failure (without crashing root goals) and benchmark self-evolving tools before authorizing live hot-reloads.
- **Receive-Only Solana Settlement:** Tracks real incoming USDC and SOL transfers to the agent's public receive address (`3t7xtNf5vyb7XKMFoNXaZJ7yW4dx8L8CN1LjcCLEacER`) to update internal balances—strictly without private keys or outgoing transaction signing.

---

## Features

- **Dual-Engine Execution (System 1 & System 2):**
  - Deterministic fast-path dispatch for verified meta-tools.
  - Deep-path triage with multi-provider model routing (Gemini, Groq, OpenRouter) and fallback chains.
- **Zero-Trust A2A Protocols:**
  - Ed25519 cryptographic message authentication and passport verification.
  - Dynamically versioned, cryptographically signed Agent Cards published at `/.well-known/agent-card.json`.
  - HTTP and WebSocket bidirectional A2A communication transports.
- **M2M Economic & Financial Layer:**
  - Machine-to-Machine Escrow (`EscrowSystem`) locking funds during execution with release, dispute, and refund mechanics.
  - Real-time double-entry ledger (`Ledger`) tracking assets, revenue, and platform fees.
  - Weighted multidimensional reputation scoring across delivery success, latency, eval scores, and evolutions.
  - Dynamic pricing engine factoring in baseline margins, workload congestion, and peer reputation.
- **Opportunity Discovery & Economic Brain:**
  - `OpportunityScanner` polling external feeds and adapters (including `LocalFeedOpportunityAdapter`).
  - `EconomicBrain` evaluating opportunities across skill matching, cost-vs-reward ROI calculations, capacity limits, deadline feasibility, and requester reputation.
  - Strict decision outputs (`ACCEPT`, `REJECT`, `COUNTER_OFFER`) where only `ACCEPT` grants execution permission.
- **HTN Planning & Morphling Re-planning:**
  - Hierarchical Task Network (HTN) planner decomposing complex goals into dependency-ordered `TaskGraph` DAGs.
  - Kahn's topological sorting and dynamic ready-task dependency resolution.
  - In-flight dynamic re-planning on subtask failures: parameter adaptation (budget/timeout increase), peer failover rerouting, and dynamic node splitting into recovery branches.
- **Ratchet Immune System:**
  - Automated sandbox testing and regression benchmarking (`EvalPack`) of candidate meta-tools.
  - Automatic rollback on performance regression (>20% latency increase) or security violations.
- **Receive-Only Solana Payment Monitor:**
  - Public receive-only wallet monitoring on Solana mainnet.
  - Detects verified incoming USDC (SPL token) and native SOL transfers via standard JSON-RPC.
  - Automatically credits the double-entry ledger and emits telemetry without any private keys or payment simulation.
- **Production Hardening & Observability:**
  - Resilient circuit breakers with state transitions (`CLOSED`, `OPEN`, `HALF_OPEN`) protecting against cascading provider and peer failures.
  - Multi-tier granular rate limiter (global, per-peer, and per-skill token buckets).
  - Atomic snapshot persistence for reputation, escrow, telemetry, and card history (`.tmp` write + atomic rename).
  - Health (`/health`), readiness (`/ready`), Prometheus metrics (`/metrics`), and REST dashboard endpoints.

---

## Requirements

- **Node.js:** `>= 22.0.0`
- **Package Manager:** `npm` (v10+) or `tsx`
- **Operating System:** Linux, macOS, or Windows (WSL recommended)
- **Optional External Services:**
  - PostgreSQL database (for persistent transaction ledger and learning stores; defaults to embedded or mock URL for testing).
  - Solana RPC Endpoint (e.g. `https://api.mainnet-beta.solana.com` or private RPC provider) for monitoring receive-only payments.
  - LLM API Keys (optional for local/test mode; configure Gemini, Groq, or OpenRouter for live LLM execution).

---

## Quick Start (Local)

```bash
# 1. Clone the repository
git clone https://github.com/your-org/a2a-pool-agent.git
cd a2a-pool-agent

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env

# Edit .env with your local settings (ports, database, RPC, and optional LLM keys)
nano .env

# 4. Run typecheck and automated test suite
npm run typecheck
npm test

# 5. Start the development server (hot reload on port 3000)
npm run dev
```

### Production Build & Run

```bash
# Compile TypeScript to dist/
npm run build

# Start production server
npm start
```

---

## Operational Endpoints

Once running (default port `3000`), the agent exposes:

| Endpoint | Method | Description |
|---|---|---|
| `/health` | `GET` | Liveness probe returning health state, uptime, and draining status |
| `/ready` | `GET` | Readiness probe validating cryptographic identity, ledger balance, and active adapters |
| `/metrics` | `GET` | Plain-text Prometheus metrics export (`version=0.0.4`) |
| `/api/metrics` | `GET` | JSON aggregated execution metrics, A2A success rates, and token usage |
| `/api/status` | `GET` | Complete agent operational status, budget state, and account balances |
| `/api/ledger` | `GET` | Recent double-entry transactions and cryptographic integrity verification |
| `/api/wallet` | `GET` | Receive-only Solana wallet address, tracked balances, and mint info |
| `/.well-known/agent-card.json` | `GET` | Cryptographically signed Agent Card (JWS Ed25519) |
