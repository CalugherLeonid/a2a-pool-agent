import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentCore } from '../agent.js';

describe('Graceful Shutdown & Lifecycle Management', () => {
  let mockRegistry: any;
  let mockSigner: any;
  let mockTriage: any;
  let mockExecutor: any;
  let mockQuality: any;
  let mockLedger: any;
  let mockLearning: any;
  let mockBudget: any;
  let mockPersistenceManager: any;

  beforeEach(() => {
    mockRegistry = {
      all: () => [],
      stopAll: vi.fn().mockResolvedValue(undefined),
    };
    mockSigner = {
      sign: vi.fn().mockReturnValue('mock-sig'),
      pubkeyPem: () => 'pem',
    };
    mockTriage = {
      decide: vi.fn(),
    };
    mockExecutor = {
      execute: vi.fn(),
    };
    mockQuality = {
      check: vi.fn(),
    };
    mockLedger = {
      lockFunds: vi.fn().mockResolvedValue('tx-1'),
      releaseFunds: vi.fn().mockResolvedValue(undefined),
      refundFunds: vi.fn().mockResolvedValue(undefined),
    };
    mockLearning = {
      record: vi.fn().mockResolvedValue(undefined),
    };
    mockBudget = {
      used: 0,
      cap: 10,
      wouldExceed: () => false,
      record: vi.fn(),
    };
    mockPersistenceManager = {
      saveAll: vi.fn().mockResolvedValue(undefined),
      loadAll: vi.fn().mockResolvedValue({
        reputation: true,
        escrow: true,
        cardManager: true,
        telemetry: true,
      }),
    };
  });

  it('respinge task-urile primite pe adapter dacă agentul este în proces de oprire (isDraining)', async () => {
    const core = new AgentCore({
      registry: mockRegistry,
      signer: mockSigner,
      triage: mockTriage,
      executor: mockExecutor,
      quality: mockQuality,
      ledger: mockLedger,
      learning: mockLearning,
      budget: mockBudget,
      agentId: 'agent-drain-test',
      workerId: 'worker-1',
      delayFloorHours: 1,
    });

    expect(core.isDraining()).toBe(false);

    // Declanșează stop()
    await core.stop(500);
    expect(core.isDraining()).toBe(true);

    const mockAdapter = {
      id: 'mock-marketplace',
      reject: vi.fn().mockResolvedValue(undefined),
      capabilities: () => ['text'],
    } as any;

    const rawTask = {
      id: 'task-drain-1',
      type: 'text',
      input: 'hello',
      budgetEstimateUsd: 0.1,
    } as any;

    await (core as any).handleTask(mockAdapter, rawTask);

    expect(mockAdapter.reject).toHaveBeenCalledWith('task-drain-1', 'agent_draining');
    expect(mockTriage.decide).not.toHaveBeenCalled();
  });

  it('respinge request-urile A2A de la peer-i cu 503 când agentul este în oprire', async () => {
    const core = new AgentCore({
      registry: mockRegistry,
      signer: mockSigner,
      triage: mockTriage,
      executor: mockExecutor,
      quality: mockQuality,
      ledger: mockLedger,
      learning: mockLearning,
      budget: mockBudget,
      agentId: 'agent-a2a-drain',
      workerId: 'worker-1',
      delayFloorHours: 1,
    });

    await core.stop(500);

    const result = await core.handleIncomingA2ARequest({
      taskId: 'a2a-task-drain',
      toolId: 'some-tool',
      parameters: {},
      costUsd: 0.05,
      clientAgentId: 'client-peer',
      providerAgentId: 'agent-a2a-drain',
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('503 Service Unavailable');
    expect(result.escrowStatus).toBe('failed');
  });

  it('așteaptă finalizarea task-urilor in-flight și persistă starea la graceful shutdown', async () => {
    const core = new AgentCore({
      registry: mockRegistry,
      signer: mockSigner,
      triage: mockTriage,
      executor: mockExecutor,
      quality: mockQuality,
      ledger: mockLedger,
      learning: mockLearning,
      budget: mockBudget,
      agentId: 'agent-save-test',
      workerId: 'worker-1',
      delayFloorHours: 1,
      persistenceManager: mockPersistenceManager,
    });

    // Simulează un task in-flight
    (core as any).inFlightTasks.add('task-flying-1');
    expect(core.getInFlightTaskCount()).toBe(1);

    // Oprește task-ul după 80ms
    setTimeout(() => {
      (core as any).inFlightTasks.delete('task-flying-1');
    }, 80);

    await core.stop(2000);

    expect(core.getInFlightTaskCount()).toBe(0);
    expect(mockRegistry.stopAll).toHaveBeenCalled();
    // Verifică că saveAll a fost chemat pentru a salva starea
    expect(mockPersistenceManager.saveAll).toHaveBeenCalled();
  });

  it('hydrateState() încarcă starea salvată la pornire', async () => {
    const core = new AgentCore({
      registry: mockRegistry,
      signer: mockSigner,
      triage: mockTriage,
      executor: mockExecutor,
      quality: mockQuality,
      ledger: mockLedger,
      learning: mockLearning,
      budget: mockBudget,
      agentId: 'agent-hydrate-test',
      workerId: 'worker-1',
      delayFloorHours: 1,
      persistenceManager: mockPersistenceManager,
    });

    await core.hydrateState();
    expect(mockPersistenceManager.loadAll).toHaveBeenCalled();
  });
});
