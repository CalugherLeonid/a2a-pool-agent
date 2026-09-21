/**
 * Web Dashboard and REST API for A2A Pool Agent.
 *
 * Serves the live operational UI and status endpoints on port 3000.
 */

import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { env } from '../config/env.js';
import type { Signer } from '../identity/ed25519.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { BudgetGuard } from '../core/budget.js';
import type { Ledger } from '../core/ledger.js';
import type { LearningStore } from '../core/learning.js';
import type { EconomicsConfig } from '../config/economics.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('dashboard');

export interface DashboardDeps {
  signer: Signer;
  registry: AdapterRegistry;
  budget: BudgetGuard;
  ledger: Ledger;
  learning: LearningStore;
  economics: EconomicsConfig;
  startTime: Date;
}

export function createDashboardServer(deps: DashboardDeps): Server {
  const app = express();
  app.use(express.json());

  // Health check
  app.get(['/health', '/api/health'], (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      agentId: env.AGENT_ID,
      agentName: env.AGENT_NAME,
      environment: env.AGENT_ENVIRONMENT,
      uptimeSeconds: Math.floor((Date.now() - deps.startTime.getTime()) / 1000),
    });
  });

  // System status
  app.get('/api/status', async (_req: Request, res: Response) => {
    try {
      const accounts = await deps.ledger.getAccountBalances();
      const usedToday = deps.budget.used;
      const capToday = deps.budget.cap;
      const uptimeS = Math.floor((Date.now() - deps.startTime.getTime()) / 1000);

      res.json({
        agent: {
          id: env.AGENT_ID,
          name: env.AGENT_NAME,
          environment: env.AGENT_ENVIRONMENT,
          pubkey: deps.signer.pubkeyPem().split('\n')[1] || deps.signer.pubkeyPem(),
          fullPubkey: deps.signer.pubkeyPem(),
          uptimeSeconds: uptimeS,
        },
        budget: {
          usedUsd: usedToday,
          capUsd: capToday,
          remainingUsd: Math.max(0, capToday - usedToday),
          pctUsed: capToday > 0 ? (usedToday / capToday) * 100 : 0,
        },
        economics: {
          delayFloorHours: deps.economics.delay_floor_hours,
          modelRouter: deps.economics.model_router,
          minProfitUsd: env.MIN_PROFIT_USD,
          minSuccessProbability: env.MIN_SUCCESS_PROBABILITY,
          pollIntervalMs: env.POLL_INTERVAL_MS,
        },
        adapters: deps.registry.health(),
        accounts,
      });
    } catch (err: unknown) {
      log.error({ err }, 'error fetching status');
      res.status(500).json({ error: String(err) });
    }
  });

  // Ledger data
  app.get('/api/ledger', async (req: Request, res: Response) => {
    try {
      const limit = Number(req.query.limit || 25);
      const accounts = await deps.ledger.getAccountBalances();
      const transactions = await deps.ledger.getRecentTransactions(limit);
      const integrity = await deps.ledger.verifyIntegrity();

      res.json({
        accounts,
        transactions,
        integrity,
      });
    } catch (err: unknown) {
      log.error({ err }, 'error fetching ledger');
      res.status(500).json({ error: String(err) });
    }
  });

  // Learning data
  app.get('/api/learning', async (_req: Request, res: Response) => {
    try {
      const costToday = await deps.learning.costToday();
      const bestModels = await deps.learning.bestModel('extract', 'mock', 7, 1);
      const recentEvents = await deps.learning.recentEvents(20);

      res.json({
        costToday,
        bestModels,
        recentEvents,
      });
    } catch (err: unknown) {
      log.error({ err }, 'error fetching learning');
      res.status(500).json({ error: String(err) });
    }
  });

  // Serve Dashboard UI
  app.get('/', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderDashboardHtml());
  });

  const port = env.CORE_PORT || 3000;
  const server = app.listen(port, '0.0.0.0', () => {
    log.info({ port, host: '0.0.0.0' }, 'dashboard server listening');
  });

  return server;
}

function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>A2A Pool Agent — Live Operations Dashboard</title>
  <style>
    :root {
      --bg: #090d16;
      --card: #111726;
      --card-hover: #161f33;
      --border: #1e293b;
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.15);
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --mono: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
      --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 14px;
      line-height: 1.5;
      padding-bottom: 40px;
    }
    header {
      background: var(--card);
      border-bottom: 1px solid var(--border);
      padding: 16px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .status-pulse {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 12px var(--success);
      animation: pulse 2s infinite ease-in-out;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.9); }
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge-green { background: rgba(16, 185, 129, 0.15); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-blue { background: rgba(56, 189, 248, 0.15); color: var(--accent); border: 1px solid rgba(56, 189, 248, 0.3); }
    .badge-amber { background: rgba(245, 158, 11, 0.15); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.3); }
    .container {
      max-width: 1320px;
      margin: 24px auto;
      padding: 0 20px;
    }
    .grid-kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      position: relative;
    }
    .kpi-title {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .kpi-value {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: var(--text);
    }
    .kpi-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .progress-bar {
      height: 6px;
      background: #1e293b;
      border-radius: 3px;
      margin-top: 10px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: var(--accent);
      width: 0%;
      transition: width 0.3s ease;
    }
    .tabs {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
      overflow-x: auto;
    }
    .tab-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .tab-btn:hover { color: var(--text); }
    .tab-btn.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      padding: 12px 14px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th {
      color: var(--text-muted);
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    tr:hover td { background: var(--card-hover); }
    .mono { font-family: var(--mono); }
    .text-success { color: var(--success); }
    .text-danger { color: var(--danger); }
    .text-accent { color: var(--accent); }
    .split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
    @media (max-width: 900px) {
      .split { grid-template-columns: 1fr; }
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }
    .card-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text);
    }
    .copy-btn {
      background: #1e293b;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      cursor: pointer;
    }
    .copy-btn:hover { color: var(--text); background: #334155; }
    .event-item {
      padding: 12px;
      border-radius: 8px;
      background: #0f172a;
      border: 1px solid var(--border);
      margin-bottom: 10px;
    }
    .event-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      margin-bottom: 6px;
    }
  </style>
</head>
<body>

  <header id="main-header">
    <div class="brand">
      <div class="status-pulse" title="Agent Online"></div>
      <div>
        <h1 style="font-size: 17px; font-weight: 700; letter-spacing: -0.3px;">A2A Pool Agent</h1>
        <div style="font-size: 11px; color: var(--text-muted);">Autonomous Multi-Marketplace Delivery Agent</div>
      </div>
      <span class="badge badge-green" id="agent-env">development</span>
      <span class="badge badge-blue" id="agent-model">Gemini</span>
    </div>
    <div style="display: flex; align-items: center; gap: 14px;">
      <div style="text-align: right;">
        <div style="font-size: 11px; color: var(--text-muted);">UPTIME</div>
        <div id="uptime-display" class="mono" style="font-size: 13px; font-weight: 600;">00:00:00</div>
      </div>
      <button class="copy-btn" onclick="copyPubkey()" id="btn-copy-key">Copy Ed25519 Pubkey</button>
    </div>
  </header>

  <main class="container">
    <!-- TOP KPIS -->
    <div class="grid-kpis">
      <div class="card" id="kpi-budget">
        <div class="kpi-title">Daily Budget</div>
        <div class="kpi-value" id="kpi-budget-val">$0.0000</div>
        <div class="kpi-sub" id="kpi-budget-sub">Cap: $5.0000 / day</div>
        <div class="progress-bar">
          <div class="progress-fill" id="kpi-budget-bar"></div>
        </div>
      </div>

      <div class="card" id="kpi-revenue">
        <div class="kpi-title">Settled Gross Revenue</div>
        <div class="kpi-value text-success" id="kpi-rev-val">$0.0000</div>
        <div class="kpi-sub" id="kpi-rev-sub">Total payments from pools</div>
      </div>

      <div class="card" id="kpi-cost">
        <div class="kpi-title">LLM Execution Cost</div>
        <div class="kpi-value text-accent" id="kpi-cost-val">$0.0000</div>
        <div class="kpi-sub" id="kpi-cost-sub">Total provider tokens cost</div>
      </div>

      <div class="card" id="kpi-net">
        <div class="kpi-title">Net Operating Profit</div>
        <div class="kpi-value text-success" id="kpi-net-val">$0.0000</div>
        <div class="kpi-sub" id="kpi-net-sub">Net retained across wallets</div>
      </div>
    </div>

    <!-- TABS -->
    <div class="tabs">
      <button class="tab-btn active" onclick="switchTab('feed', this)">Live Activity Stream</button>
      <button class="tab-btn" onclick="switchTab('ledger', this)">Double-Entry Ledger</button>
      <button class="tab-btn" onclick="switchTab('adapters', this)">Marketplace Adapters</button>
      <button class="tab-btn" onclick="switchTab('learning', this)">Learning & Models</button>
      <button class="tab-btn" onclick="switchTab('identity', this)">Identity & Architecture</button>
    </div>

    <!-- PANE 1: FEED -->
    <div id="pane-feed" class="tab-pane active">
      <div class="split">
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Live Settlement Feed</h2>
            <span class="badge badge-green">Auto-Polling</span>
          </div>
          <div id="feed-list" style="max-height: 520px; overflow-y: auto;">
            <div style="color: var(--text-muted); text-align: center; padding: 40px;">Polling for tasks...</div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Recent Transactions</h2>
            <span class="badge badge-blue">Double-Entry</span>
          </div>
          <div style="overflow-x: auto;">
            <table>
              <thead>
                <tr>
                  <th>Task ID</th>
                  <th>Adapter</th>
                  <th>Status</th>
                  <th>Entries (Dr / Cr)</th>
                </tr>
              </thead>
              <tbody id="tx-tbody">
                <tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Waiting for settlements...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- PANE 2: LEDGER -->
    <div id="pane-ledger" class="tab-pane">
      <div class="card" style="margin-bottom: 20px;">
        <div class="card-header">
          <h2 class="card-title">Chart of Accounts & Live Balances</h2>
          <span class="badge badge-green" id="integrity-badge">Integrity: Balanced</span>
        </div>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Account Name</th>
                <th>Type</th>
                <th>Debit Balance</th>
                <th>Credit Balance</th>
                <th>Net Balance</th>
              </tr>
            </thead>
            <tbody id="ledger-accounts-tbody">
              <tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Loading accounts...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- PANE 3: ADAPTERS -->
    <div id="pane-adapters" class="tab-pane">
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">Mock Marketplace</div>
              <div style="font-size: 11px; color: var(--text-muted);">Local Autonomous Task Pool</div>
            </div>
            <span class="badge badge-green">Enabled</span>
          </div>
          <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">Generates synthetic tasks (extract, summarize, sentiment, code_review) to continuously exercise triage, quality scoring, Ed25519 signing, and ledger settlement.</p>
          <div style="font-size: 12px; color: var(--text);">Poll Interval: <strong>5000 ms</strong></div>
          <div style="font-size: 12px; color: var(--text); margin-top: 4px;">Status: <strong class="text-success">Active & Polling</strong></div>
        </div>

        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">Railway Pool</div>
              <div style="font-size: 11px; color: var(--text-muted);">Central HTTP Work Pool</div>
            </div>
            <span class="badge badge-amber">Configured</span>
          </div>
          <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">Polls railway pool server, publishes Ed25519 worker identity, claims distributed tasks, and submits signed cryptographic payloads.</p>
          <div style="font-size: 12px; color: var(--text);">Worker ID: <strong>agent-001</strong></div>
          <div style="font-size: 12px; color: var(--text); margin-top: 4px;">Credentials: <strong>RAILWAY_POOL_URL (Env)</strong></div>
        </div>

        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">OKX Agent Task</div>
              <div style="font-size: 11px; color: var(--text-muted);">X Layer Smart Contract Marketplace</div>
            </div>
            <span class="badge badge-blue">Ready</span>
          </div>
          <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">On-chain task settlement with gas calculation, contract escrows, and Solana/EVM wallet coordination.</p>
          <div style="font-size: 12px; color: var(--text);">Mode: <strong>Demo / Testnet</strong></div>
        </div>
      </div>
    </div>

    <!-- PANE 4: LEARNING -->
    <div id="pane-learning" class="tab-pane">
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Dynamic Model Calibration & Learning Store</h2>
          <span class="badge badge-blue">Bayesian Prior: 0.70</span>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 16px;">
          The agent updates its empirical priors with every outcome. It estimates real costs, actual latency, and execution success probability to optimize future triage decisions.
        </p>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Provider</th>
                <th>Avg Cost (USD)</th>
                <th>Avg Quality</th>
                <th>Success Rate</th>
                <th>Avg Latency</th>
                <th>Samples</th>
              </tr>
            </thead>
            <tbody id="models-tbody">
              <tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Gathering learning statistics...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- PANE 5: IDENTITY -->
    <div id="pane-identity" class="tab-pane">
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Agent Identity & Cryptographic Passport</h2>
        </div>
        <div style="margin-bottom: 16px;">
          <div class="kpi-title">Agent UUID</div>
          <div class="mono" id="id-agent-id" style="font-size: 13px; color: var(--accent);">Loading...</div>
        </div>
        <div style="margin-bottom: 16px;">
          <div class="kpi-title">Ed25519 Public Key (SPKI)</div>
          <pre id="id-pubkey" class="mono" style="background: #0a0f1d; padding: 12px; border-radius: 6px; font-size: 11px; overflow-x: auto; color: #a5f3fc; border: 1px solid var(--border);"></pre>
        </div>
        <div>
          <div class="kpi-title">Architecture Pipeline</div>
          <div style="font-size: 13px; color: var(--text-muted); line-height: 1.8;">
            <code>DISCOVER</code> → <code>TRIAGE</code> (profit & delay floor) → <code>BUDGET</code> (daily cap guard) → <code>ACCEPT</code> → <code>EXECUTE</code> (Gemini / Groq / OpenRouter) → <code>QUALITY</code> (schema & validation) → <code>SIGN & DELIVER</code> (Ed25519 SHA256) → <code>LEDGER</code> (double-entry settlement) → <code>LEARN</code> (empirical calibration)
          </div>
        </div>
      </div>
    </div>

  </main>

  <script>
    let fullPubkey = '';

    function switchTab(name, btn) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('pane-' + name).classList.add('active');
    }

    function formatUsd(n) {
      return '$' + Number(n || 0).toFixed(4);
    }

    function formatTime(sec) {
      const h = Math.floor(sec / 3600).toString().padStart(2, '0');
      const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
      const s = Math.floor(sec % 60).toString().padStart(2, '0');
      return h + ':' + m + ':' + s;
    }

    async function copyPubkey() {
      if (!fullPubkey) return;
      try {
        await navigator.clipboard.writeText(fullPubkey);
        const btn = document.getElementById('btn-copy-key');
        btn.innerText = 'Copied!';
        setTimeout(() => btn.innerText = 'Copy Ed25519 Pubkey', 2000);
      } catch {
        alert(fullPubkey);
      }
    }

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();

        // Agent info
        document.getElementById('agent-env').innerText = data.agent.environment;
        document.getElementById('uptime-display').innerText = formatTime(data.agent.uptimeSeconds);
        document.getElementById('id-agent-id').innerText = data.agent.id;
        document.getElementById('id-pubkey').innerText = data.agent.fullPubkey;
        fullPubkey = data.agent.fullPubkey;

        // Budget
        document.getElementById('kpi-budget-val').innerText = formatUsd(data.budget.usedUsd);
        document.getElementById('kpi-budget-sub').innerText = 'Cap: ' + formatUsd(data.budget.capUsd) + ' / day';
        document.getElementById('kpi-budget-bar').style.width = Math.min(100, data.budget.pctUsed) + '%';

        // Accounts summary
        if (data.accounts && data.accounts.length) {
          const revAcc = data.accounts.find(a => a.code === 'revenue');
          const execAcc = data.accounts.find(a => a.code === 'execution_cost');
          const walletMock = data.accounts.find(a => a.code === 'wallet_mock');

          const rev = revAcc ? revAcc.balance : 0;
          const cost = execAcc ? execAcc.balance : 0;
          const net = walletMock ? walletMock.balance : (rev - cost);

          document.getElementById('kpi-rev-val').innerText = formatUsd(rev);
          document.getElementById('kpi-cost-val').innerText = formatUsd(cost);
          document.getElementById('kpi-net-val').innerText = formatUsd(net);
        }
      } catch (err) {
        console.error('Status fetch error:', err);
      }
    }

    async function fetchLedger() {
      try {
        const res = await fetch('/api/ledger');
        const data = await res.json();

        // Integrity
        const intBadge = document.getElementById('integrity-badge');
        if (data.integrity && data.integrity.balanced) {
          intBadge.className = 'badge badge-green';
          intBadge.innerText = 'Integrity: Balanced ($0 diff)';
        } else {
          intBadge.className = 'badge badge-amber';
          intBadge.innerText = 'Integrity: Verifying...';
        }

        // Accounts table
        const accTbody = document.getElementById('ledger-accounts-tbody');
        if (data.accounts && data.accounts.length > 0) {
          accTbody.innerHTML = data.accounts.map(a => {
            const net = Number(a.balance);
            const netClass = net > 0 ? 'text-success' : (net < 0 ? 'text-danger' : '');
            return '<tr>' +
              '<td class="mono"><strong>' + a.code + '</strong></td>' +
              '<td>' + a.name + '</td>' +
              '<td><span class="badge badge-blue">' + a.type + '</span></td>' +
              '<td class="mono">' + formatUsd(a.totalDebit) + '</td>' +
              '<td class="mono">' + formatUsd(a.totalCredit) + '</td>' +
              '<td class="mono ' + netClass + '"><strong>' + formatUsd(a.balance) + '</strong></td>' +
            '</tr>';
          }).join('');
        }

        // Transactions table
        const txTbody = document.getElementById('tx-tbody');
        if (data.transactions && data.transactions.length > 0) {
          txTbody.innerHTML = data.transactions.slice(0, 8).map(t => {
            const entriesStr = (t.entries || []).map(e =>
              e.accountCode + ' (' + (e.debit > 0 ? 'Dr $' + e.debit.toFixed(4) : 'Cr $' + e.credit.toFixed(4)) + ')'
            ).join(', ');
            return '<tr>' +
              '<td class="mono">' + t.task_id + '</td>' +
              '<td><span class="badge badge-blue">' + t.adapter_id + '</span></td>' +
              '<td><span class="badge badge-green">' + t.status + '</span></td>' +
              '<td class="mono" style="font-size: 11px; color: var(--text-muted);">' + entriesStr + '</td>' +
            '</tr>';
          }).join('');
        }
      } catch (err) {
        console.error('Ledger fetch error:', err);
      }
    }

    async function fetchLearning() {
      try {
        const res = await fetch('/api/learning');
        const data = await res.json();

        // Feed list
        const feedList = document.getElementById('feed-list');
        if (data.recentEvents && data.recentEvents.length > 0) {
          feedList.innerHTML = data.recentEvents.map(e => {
            const time = new Date(e.ts).toLocaleTimeString();
            return '<div class="event-item">' +
              '<div class="event-top">' +
                '<span><strong class="mono">' + e.task_id + '</strong> (' + e.task_type + ')</span>' +
                '<span class="text-muted">' + time + '</span>' +
              '</div>' +
              '<div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px;">' +
                '<span class="badge badge-green">Success</span>' +
                '<span class="badge badge-blue">' + (e.actual_model || 'gemini') + '</span>' +
                '<span class="mono" style="font-size: 11px; color: var(--text-muted);">Cost: ' + formatUsd(e.actual_cost_usd) + '</span>' +
                '<span class="mono" style="font-size: 11px; color: var(--success);">Profit: ' + formatUsd(e.profit_usd) + '</span>' +
              '</div>' +
            '</div>';
          }).join('');
        }

        // Models table
        const modelsTbody = document.getElementById('models-tbody');
        if (data.bestModels && data.bestModels.length > 0) {
          modelsTbody.innerHTML = data.bestModels.map(m => {
            return '<tr>' +
              '<td class="mono"><strong>' + m.model + '</strong></td>' +
              '<td>' + m.provider + '</td>' +
              '<td class="mono">' + formatUsd(m.avgCost) + '</td>' +
              '<td class="mono">' + (m.avgQuality * 100).toFixed(1) + '%</td>' +
              '<td class="mono text-success">' + (m.successRate * 100).toFixed(1) + '%</td>' +
              '<td class="mono">' + m.avgLatency.toFixed(0) + ' ms</td>' +
              '<td class="mono">' + m.n + '</td>' +
            '</tr>';
          }).join('');
        }
      } catch (err) {
        console.error('Learning fetch error:', err);
      }
    }

    async function poll() {
      await Promise.all([fetchStatus(), fetchLedger(), fetchLearning()]);
    }

    poll();
    setInterval(poll, 3000);
  </script>
</body>
</html>`;
}
