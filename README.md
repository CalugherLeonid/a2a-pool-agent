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

Prerequisites: Node 22+, pnpm 9+.

```bash
nvm use
pnpm install
cp .env.example .env
# edit .env with your credentials (Neon, Gemini, Groq, ...)
pnpm typecheck