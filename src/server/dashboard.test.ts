import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDashboardServer } from './dashboard.js';
import { TelemetryCollector } from '../telemetry/metrics.js';

describe('Dashboard HTTP Endpoints - Health, Readiness, and Observability', () => {
  let server: Server;
  let baseUrl: string;
  let isDrainingState = false;
  let ledgerBalancedState = true;
  let hasActiveAdapters = true;

  const mockSigner = {
    pubkeyPem: () => '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END PUBLIC KEY-----',
    sign: () => 'sig',
    verify: () => true,
  } as any;

  const mockRegistry = {
    ids: () => (hasActiveAdapters ? ['railway-adapter'] : []),
    health: () => ({ 'railway-adapter': 'ok' }),
  } as any;

  const mockBudget = {
    used: 0.1,
    cap: 5.0,
  } as any;

  const mockLedger = {
    verifyIntegrity: async () => ({
      balanced: ledgerBalancedState,
      totalDebit: 10,
      totalCredit: 10,
      imbalancedTxIds: [],
    }),
    getAccountBalances: async () => [],
  } as any;

  const mockLearning = {
    costToday: async () => 0.05,
    bestModel: async () => undefined,
    recentEvents: async () => [],
  } as any;

  const mockEconomics = {
    delay_floor_hours: 24,
    learning_window_days: 7,
    estimated_gas_cost_usd: 0,
    min_learning_events: 1,
    success_probability_prior: 0.8,
    model_router: { mode: 'fixed', fixed_model: 'gemini', min_samples_for_learning: 5 },
  } as any;

  const telemetry = new TelemetryCollector();
  telemetry.recordTask(true);
  telemetry.recordExecution(
    {
      provider: 'gemini',
      model: 'gemini-1.5-flash',
      tokensIn: 50,
      tokensOut: 100,
      costUsd: 0.001,
      latencyMs: 150,
      fallbackUsed: false,
      fallbackChain: ['gemini'],
      systemPath: 'system1',
      timestamp: new Date().toISOString(),
    },
    true,
  );

  beforeAll(async () => {
    server = createDashboardServer({
      signer: mockSigner,
      registry: mockRegistry,
      budget: mockBudget,
      ledger: mockLedger,
      learning: mockLearning,
      economics: mockEconomics,
      startTime: new Date(Date.now() - 30_000),
      port: 0, // OS assigns an ephemeral free port
      telemetry,
      agentCore: {
        isDraining: () => isDrainingState,
        getInFlightTaskCount: () => (isDrainingState ? 1 : 0),
        dynamicCardManager: {
          getVersion: () => '1.2.3',
          getCurrentCard: () => ({ name: 'TestAgent' }),
        },
      },
    });

    await new Promise<void>((resolve) => {
      if (server.listening) {
        resolve();
      } else {
        server.on('listening', resolve);
      }
    });

    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('GET /health (liveness) returnează 200 cu detalii uptime și versiune', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.status).toBe('healthy');
    expect(body.version).toBe('1.2.3');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(30);
    expect(body.agentId).toBeDefined();
  });

  it('GET /ready returnează 200 OK când toate componentele critice sunt sănătoase', async () => {
    isDrainingState = false;
    ledgerBalancedState = true;
    hasActiveAdapters = true;

    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.status).toBe('ready');
    expect(body.checks.identity.status).toBe('ok');
    expect(body.checks.ledger.status).toBe('ok');
    expect(body.checks.registry.status).toBe('ok');
    expect(body.checks.lifecycle.status).toBe('ok');
  });

  it('GET /ready returnează 503 când agentul se află în proces de oprire (draining)', async () => {
    isDrainingState = true;

    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(503);

    const body = (await res.json()) as any;
    expect(body.status).toBe('not_ready');
    expect(body.checks.lifecycle.status).toBe('error');
    expect(body.checks.lifecycle.details).toContain('draining');

    isDrainingState = false;
  });

  it('GET /ready returnează 503 când integritatea ledgerului este compromisă', async () => {
    ledgerBalancedState = false;

    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(503);

    const body = (await res.json()) as any;
    expect(body.status).toBe('not_ready');
    expect(body.checks.ledger.status).toBe('error');

    ledgerBalancedState = true;
  });

  it('GET /ready returnează 503 când nu există adaptoare de marketplace active', async () => {
    hasActiveAdapters = false;

    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(503);

    const body = (await res.json()) as any;
    expect(body.status).toBe('not_ready');
    expect(body.checks.registry.status).toBe('error');

    hasActiveAdapters = true;
  });

  it('GET /metrics exportă datele în format Prometheus text', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');

    const text = await res.text();
    expect(text).toContain('# HELP agent_tasks_total');
    expect(text).toContain('# TYPE agent_tasks_total counter');
    expect(text).toContain('agent_tasks_total 1');
  });

  it('GET /api/metrics returnează metrici structurate JSON', async () => {
    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.raw).toBeDefined();
    expect(body.aggregated).toBeDefined();
    expect(body.raw.totalExecutions).toBe(1);
    expect(body.raw.successfulExecutions).toBe(1);
    expect(body.aggregated.system1Count).toBe(1);
  });
});
