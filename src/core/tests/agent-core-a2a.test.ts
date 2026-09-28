import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AgentCore } from '../agent.js';
import { TriageEngine, PriorSuccessProbabilityProvider } from '../triage.js';
import { A2ACapability } from '../a2a-capability.js';
import { A2AAgentOrchestrator } from '../a2a-orchestrator.js';
import { MetaToolRegistry } from '../meta-tools/registry.js';
import { EscrowSystem } from '../escrow.js';
import { StaticCostEstimator } from '../cost-estimator.js';
import { FixedModelRouter } from '../model-router.js';
import { AgentIdentity } from '../../identity/agent-identity.js';
import { PeerRegistry } from '../../adapters/a2a/peer-registry.js';
import { A2AHttpTransport } from '../../adapters/a2a/http-transport.js';
import type { Signer } from '../../identity/ed25519.js';
import type { MarketplaceAdapter } from '../../adapters/adapter.js';
import type {
  AdapterCapabilities,
  RawTask,
  AcceptanceResult,
  SettlementReceipt,
} from '../types/index.js';

describe('Etapa 1: AgentCore + A2A & System 1 / System 2 Triage', () => {
  const defaultCaps: AdapterCapabilities = {
    supports: {
      negotiation: false,
      bidding: false,
      webhooks: false,
      streaming: false,
      multipleWallets: false,
      managedRuntime: false,
    },
    requires: {
      onChainIdentity: false,
      hmacSigning: false,
      policyLayer: false,
      humanClaimant: false,
      contentScoring: false,
    },
    limits: {
      maxConcurrentTasks: 1,
      minBudgetUsd: 0.05,
      settlementCurrency: 'USD',
      averageSettlementDelayHours: 0.1,
      platformFeePct: 0.1,
    },
  };

  const thresholds = {
    minProfitUsd: 0.01,
    minSuccessProbability: 0.8,
    minTimeAdjustedProfit: 0.01,
  };

  let metaToolRegistry: MetaToolRegistry;
  let triageDeps: any;

  beforeEach(() => {
    metaToolRegistry = new MetaToolRegistry();
    metaToolRegistry.register({
      id: 'fast-json-parser',
      name: 'JSON Parser',
      description: 'Parses JSON deterministically',
      sourceCode: 'export default function(params) { return { parsed: JSON.parse(params.input) }; }',
      language: 'javascript',
      parametersSchema: { type: 'object' },
    });

    triageDeps = {
      thresholds,
      successProb: new PriorSuccessProbabilityProvider(0.95),
      modelRouter: new FixedModelRouter('gemini-2.5-flash'),
      costEstimator: new StaticCostEstimator(),
      defaultGasCostUsd: 0.001,
      delayFloorHours: 0.5,
      metaToolRegistry,
    };
  });

  describe('TriageEngine: System 1 vs. System 2', () => {
    it('System 1 fast path: matches registered meta-tool deterministically', async () => {
      const triage = new TriageEngine(triageDeps);
      const task: RawTask = {
        id: 'task-s1',
        source: 'mock',
        type: 'meta_tool',
        budgetEstimateUsd: 0.20,
        deadlineS: 60,
        prompt: 'run fast-json-parser',
        input: { toolId: 'fast-json-parser', input: '{"hello":"world"}' },
        outputSchema: { type: 'object' },
        raw: {},
        observedAt: new Date().toISOString(),
      };

      const decision = await triage.decide({
        task,
        adapterId: 'mock',
        capabilities: defaultCaps,
      });

      expect(decision.decision).toBe('ACCEPT');
      expect(decision.tier).toBe('system1_fast');
      expect(decision.matchedToolId).toBe('fast-json-parser');
      expect(decision.strategyId).toBe('system1_fast');
      expect(decision.components.expectedExecutionCostUsd).toBeLessThan(0.001);
    });

    it('System 1 instant rejection: unknown meta-tool requested', async () => {
      const triage = new TriageEngine(triageDeps);
      const task: RawTask = {
        id: 'task-unknown-tool',
        source: 'mock',
        type: 'meta_tool',
        budgetEstimateUsd: 0.50,
        deadlineS: 60,
        prompt: 'run nonexistent-tool',
        input: { toolId: 'nonexistent-tool' },
        outputSchema: { type: 'object' },
        raw: {},
        observedAt: new Date().toISOString(),
      };

      const decision = await triage.decide({
        task,
        adapterId: 'mock',
        capabilities: defaultCaps,
      });

      expect(decision.decision).toBe('REJECT');
      expect(decision.reason).toBe('reject_unknown_tool');
      expect(decision.tier).toBe('system1_fast');
    });

    it('System 1 instant rejection: expired deadline', async () => {
      const triage = new TriageEngine(triageDeps);
      const task: RawTask = {
        id: 'task-expired',
        source: 'mock',
        type: 'extract',
        budgetEstimateUsd: 1.0,
        deadlineS: 0, // expired
        prompt: 'extract text',
        outputSchema: { type: 'object' },
        raw: {},
        observedAt: new Date().toISOString(),
      };

      const decision = await triage.decide({
        task,
        adapterId: 'mock',
        capabilities: defaultCaps,
      });

      expect(decision.decision).toBe('REJECT');
      expect(decision.reason).toBe('reject_expired_deadline');
    });

    it('System 1 instant rejection: tool not in whitelist', async () => {
      const triageWithWhitelist = new TriageEngine({
        ...triageDeps,
        toolWhitelist: ['extract', 'summarize'],
      });

      const task: RawTask = {
        id: 'task-forbidden',
        source: 'mock',
        type: 'unauthorized_action',
        budgetEstimateUsd: 1.0,
        deadlineS: 60,
        prompt: 'do unauthorized thing',
        outputSchema: { type: 'object' },
        raw: {},
        observedAt: new Date().toISOString(),
      };

      const decision = await triageWithWhitelist.decide({
        task,
        adapterId: 'mock',
        capabilities: defaultCaps,
      });

      expect(decision.decision).toBe('REJECT');
      expect(decision.reason).toBe('reject_tool_not_whitelisted');
    });

    it('System 2 escalation: complex / unknown template task', async () => {
      const triage = new TriageEngine(triageDeps);
      const task: RawTask = {
        id: 'task-complex-llm',
        source: 'mock',
        type: 'complex_reasoning',
        budgetEstimateUsd: 2.0,
        deadlineS: 120,
        prompt: 'synthesize cross-domain market analysis',
        outputSchema: { type: 'object' },
        raw: {},
        observedAt: new Date().toISOString(),
      };

      const decision = await triage.decide({
        task,
        adapterId: 'mock',
        capabilities: defaultCaps,
      });

      expect(decision.decision).toBe('ACCEPT');
      expect(decision.tier).toBe('system2_deep');
      expect(decision.model).toBe('gemini-2.5-flash');
    });
  });

  describe('AgentCore with A2ACapability', () => {
    let signer: Signer;
    let escrow: EscrowSystem;
    let metaToolManager: any;
    let orchestrator: A2AAgentOrchestrator;
    let a2aCapability: A2ACapability;
    let mockLedger: any;
    let mockBudget: any;
    let mockLearning: any;
    let mockQuality: any;
    let mockExecutor: any;
    let mockRegistry: any;

    beforeEach(() => {
      signer = {
        sign: vi.fn().mockReturnValue('ed25519:abcdef123456' as any),
        pubkeyPem: vi.fn().mockReturnValue('mock-pem'),
      };
      escrow = new EscrowSystem(3);
      metaToolManager = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: { result: 'deterministic success' },
          evaluationScore: 1.0,
          ratchetDecision: 'accepted',
          metrics: { latencyMs: 5 },
          toolVersionUsed: 1,
        }),
      };
      orchestrator = new A2AAgentOrchestrator(metaToolManager, escrow);
      a2aCapability = new A2ACapability({
        orchestrator,
        metaToolManager,
        metaToolRegistry,
        escrow,
        initialBalance: 500,
      });

      mockLedger = {
        lockFunds: vi.fn().mockResolvedValue('tx-lock-1'),
        releaseFunds: vi.fn().mockResolvedValue('tx-release-1'),
        refundFunds: vi.fn().mockResolvedValue('tx-refund-1'),
      };

      mockBudget = {
        used: 0,
        cap: 100,
        wouldExceed: vi.fn().mockReturnValue(false),
        record: vi.fn(),
        snapshot: vi.fn().mockReturnValue({ usedUsd: 0, capUsd: 100 }),
      };

      mockLearning = {
        record: vi.fn().mockResolvedValue(undefined),
      };

      mockQuality = {
        check: vi.fn().mockReturnValue({
          decision: 'deliver',
          score: 1.0,
          schemaValid: true,
        }),
      };

      mockExecutor = {
        execute: vi.fn().mockResolvedValue({
          output: { summary: 'done' },
          model: 'gemini-2.5-flash',
          provider: 'google',
          tokensIn: 50,
          tokensOut: 50,
          costUsd: 0.001,
          latencyMs: 500,
        }),
      };

      mockRegistry = {
        all: vi.fn().mockReturnValue([]),
        stopAll: vi.fn().mockResolvedValue(undefined),
      };
    });

    it('instantiates AgentCore with A2ACapability and exposes helper methods', () => {
      const triage = new TriageEngine(triageDeps);
      const core = new AgentCore({
        delayFloorHours: 0.5,
        registry: mockRegistry,
        signer,
        triage,
        executor: mockExecutor,
        quality: mockQuality,
        ledger: mockLedger,
        learning: mockLearning,
        budget: mockBudget,
        agentId: 'agent-primary',
        workerId: 'worker-primary',
        a2aCapability,
      });

      expect(core.a2a).toBe(a2aCapability);
    });

    it('requestServiceFromPeer delegates via A2ACapability orchestrator and escrow', async () => {
      const triage = new TriageEngine(triageDeps);
      const core = new AgentCore({
        delayFloorHours: 0.5,
        registry: mockRegistry,
        signer,
        triage,
        executor: mockExecutor,
        quality: mockQuality,
        ledger: mockLedger,
        learning: mockLearning,
        budget: mockBudget,
        agentId: 'agent-client',
        workerId: 'worker-client',
        a2aCapability,
      });

      const response = await core.requestServiceFromPeer(
        'agent-provider',
        'fast-json-parser',
        { input: '{"test":123}' },
        10,
      );

      expect(response.success).toBe(true);
      expect(response.output).toEqual({ result: 'deterministic success' });
      expect(response.costUsd).toBe(10);
      expect(a2aCapability.getWalletBalance()).toBe(490);
    });

    it('handleIncomingA2ARequest handles peer requests when providerAgentId matches', async () => {
      const triage = new TriageEngine(triageDeps);
      const core = new AgentCore({
        delayFloorHours: 0.5,
        registry: mockRegistry,
        signer,
        triage,
        executor: mockExecutor,
        quality: mockQuality,
        ledger: mockLedger,
        learning: mockLearning,
        budget: mockBudget,
        agentId: 'agent-provider',
        workerId: 'worker-provider',
        a2aCapability,
      });

      const result = await core.handleIncomingA2ARequest({
        taskId: 'peer-task-1',
        toolId: 'fast-json-parser',
        parameters: { input: '{}' },
        costUsd: 5,
        clientAgentId: 'agent-client',
        providerAgentId: 'agent-provider',
      });

      expect(result.success).toBe(true);
      expect(result.escrowStatus).toBe('released');
    });

    it('handleIncomingA2ARequest rejects if providerAgentId does not match', async () => {
      const triage = new TriageEngine(triageDeps);
      const core = new AgentCore({
        delayFloorHours: 0.5,
        registry: mockRegistry,
        signer,
        triage,
        executor: mockExecutor,
        quality: mockQuality,
        ledger: mockLedger,
        learning: mockLearning,
        budget: mockBudget,
        agentId: 'agent-provider',
        workerId: 'worker-provider',
        a2aCapability,
      });

      const result = await core.handleIncomingA2ARequest({
        taskId: 'peer-task-1',
        toolId: 'fast-json-parser',
        parameters: { input: '{}' },
        costUsd: 5,
        clientAgentId: 'agent-client',
        providerAgentId: 'agent-other', // Mismatch!
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent ID mismatch');
      expect(result.escrowStatus).toBe('failed');
    });

    it('executes inbound marketplace task with System 1 fast path and settles ledger', async () => {
      const triage = new TriageEngine(triageDeps);

      let polled = false;
      const mockAdapter: MarketplaceAdapter = {
        id: 'test-adapter',
        displayName: 'Test Adapter',
        capabilities: () => defaultCaps,
        init: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        health: () => ({ id: 'test-adapter', status: 'idle', tasksInFlight: 0 }),
        poll: async function* () {
          if (!polled) {
            polled = true;
            yield {
              id: 'task-meta-fast',
              source: 'test-adapter',
              type: 'meta_tool',
              budgetEstimateUsd: 0.5,
              deadlineS: 30,
              prompt: 'run tool',
              input: { toolId: 'fast-json-parser', input: '{"status":"ok"}' },
              outputSchema: { type: 'object' },
              raw: {},
              observedAt: new Date().toISOString(),
            };
          }
        },
        accept: vi.fn().mockResolvedValue({ accepted: true, lockedUntil: '2026-10-01' } as AcceptanceResult),
        deliver: vi.fn().mockResolvedValue({
          taskId: 'task-meta-fast',
          adapterId: 'test-adapter',
          status: 'settled',
          currency: 'USD',
          amount: 0.5,
          amountUsd: 0.5,
          platformFeePct: 0.1,
          platformFeeAmount: 0.05,
          netAmount: 0.45,
          netAmountUsd: 0.45,
        } as SettlementReceipt),
        reject: vi.fn().mockResolvedValue(undefined),
      };

      const registry = {
        all: () => [mockAdapter],
        stopAll: vi.fn().mockResolvedValue(undefined),
      };

      const core = new AgentCore({
        delayFloorHours: 0.5,
        registry: registry as any,
        signer,
        triage,
        executor: mockExecutor,
        quality: mockQuality,
        ledger: mockLedger,
        learning: mockLearning,
        budget: mockBudget,
        agentId: 'agent-primary',
        workerId: 'worker-primary',
        a2aCapability,
      });

      await core.run();

      expect(mockAdapter.accept).toHaveBeenCalled();
      expect(mockLedger.lockFunds).toHaveBeenCalledWith({
        taskId: 'task-meta-fast',
        adapterId: 'test-adapter',
        amountUsd: 0.5,
      });
      expect(metaToolManager.execute).toHaveBeenCalledWith(
        'fast-json-parser',
        { toolId: 'fast-json-parser', input: '{"status":"ok"}' },
        undefined,
      );
      expect(mockAdapter.deliver).toHaveBeenCalled();
      expect(mockLedger.releaseFunds).toHaveBeenCalledWith({
        taskId: 'task-meta-fast',
        adapterId: 'test-adapter',
        revenueUsd: 0.5,
        platformFeeUsd: 0.05,
        executionCostUsd: 0.0001,
        gasCostUsd: 0,
      });
      expect(mockLearning.record).toHaveBeenCalled();
    });
  });

  describe('Zero-Trust Cryptographic Passports (Ed25519) on AgentCore', () => {
    let signer: Signer;
    let triage: TriageEngine;

    beforeEach(() => {
      signer = {
        sign: vi.fn().mockReturnValue('ed25519:abcdef123456' as any),
        pubkeyPem: vi.fn().mockReturnValue('mock-pem'),
      };
      triage = new TriageEngine(triageDeps);
    });

    it('automatically signs outbound A2A requests with Ed25519 passport in requestServiceFromPeer', async () => {
      let capturedRequest: any;
      const mockOrchestrator = {
        executeA2ATask: vi.fn().mockImplementation(async (req) => {
          capturedRequest = req;
          return {
            success: true,
            output: { result: 'computed' },
            escrowStatus: 'released',
            metrics: { latencyMs: 50, costUsd: 0.1 },
          };
        }),
      } as any;

      const capability = new A2ACapability({
        orchestrator: mockOrchestrator,
        metaToolManager: {} as any,
        metaToolRegistry,
        initialBalance: 100,
      });

      const core = new AgentCore({
        delayFloorHours: 0.5,
        registry: { all: () => [], stopAll: vi.fn() } as any,
        signer,
        triage,
        executor: {} as any,
        quality: {} as any,
        ledger: {} as any,
        learning: {} as any,
        budget: {} as any,
        agentId: 'agent-client',
        workerId: 'worker-client',
        a2aCapability: capability,
      });

      const response = await core.requestServiceFromPeer(
        'agent-provider',
        'fast-json-parser',
        { text: 'hello' },
        0.5,
      );

      expect(response.success).toBe(true);
      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.signature).toBeDefined();
      expect(capturedRequest.signature.startsWith('ed25519:')).toBe(true);
      expect(capturedRequest.signerPubkey).toBe(core.identity.getPublicKeyPem());
      expect(capturedRequest.clientAgentId).toBe('agent-client');
      expect(capturedRequest.providerAgentId).toBe('agent-provider');

      // Verify the signature on the captured request
      const verification = AgentIdentity.verifyA2ARequest(capturedRequest, {
        expectedProviderId: 'agent-provider',
      });
      expect(verification.valid).toBe(true);
    });

    it('rejects incoming A2A requests with tampered cryptographic signature in handleIncomingA2ARequest', async () => {
      const mockOrchestrator = {
        executeA2ATask: vi.fn().mockResolvedValue({
          success: true,
          output: { result: 'ok' },
          escrowStatus: 'released',
          metrics: { latencyMs: 10, costUsd: 0.05 },
        }),
      } as any;

      const capability = new A2ACapability({
        orchestrator: mockOrchestrator,
        metaToolManager: {} as any,
        metaToolRegistry,
      });

      const providerCore = new AgentCore({
        delayFloorHours: 0.5,
        registry: { all: () => [], stopAll: vi.fn() } as any,
        signer,
        triage,
        executor: {} as any,
        quality: {} as any,
        ledger: {} as any,
        learning: {} as any,
        budget: {} as any,
        agentId: 'agent-provider',
        workerId: 'worker-provider',
        a2aCapability: capability,
      });

      const clientIdentity = AgentIdentity.create('agent-client');
      const legitimateRequest = clientIdentity.signA2ARequest({
        taskId: 'tampered-task-1',
        toolId: 'fast-json-parser',
        parameters: { data: 'legit' },
        costUsd: 0.5,
        clientAgentId: 'agent-client',
        providerAgentId: 'agent-provider',
      });

      // Attacker tampers with the costUsd parameter
      legitimateRequest.costUsd = 0.00001;

      const result = await providerCore.handleIncomingA2ARequest(legitimateRequest);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cryptographic verification failed');
      expect(result.escrowStatus).toBe('failed');
      expect(mockOrchestrator.executeA2ATask).not.toHaveBeenCalled();
    });

    it('rejects incoming A2A requests that have expired', async () => {
      const mockOrchestrator = {
        executeA2ATask: vi.fn(),
      } as any;

      const capability = new A2ACapability({
        orchestrator: mockOrchestrator,
        metaToolManager: {} as any,
        metaToolRegistry,
      });

      const providerCore = new AgentCore({
        delayFloorHours: 0.5,
        registry: { all: () => [], stopAll: vi.fn() } as any,
        signer,
        triage,
        executor: {} as any,
        quality: {} as any,
        ledger: {} as any,
        learning: {} as any,
        budget: {} as any,
        agentId: 'agent-provider',
        workerId: 'worker-provider',
        a2aCapability: capability,
      });

      const clientIdentity = AgentIdentity.create('agent-client');
      // Request expired 20 seconds ago
      const expiredRequest = clientIdentity.signA2ARequest({
        taskId: 'expired-task-1',
        toolId: 'fast-json-parser',
        costUsd: 0.5,
        clientAgentId: 'agent-client',
        providerAgentId: 'agent-provider',
      }, -20_000);

      const result = await providerCore.handleIncomingA2ARequest(expiredRequest);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cryptographic verification failed');
      expect(result.error).toContain('expired');
      expect(mockOrchestrator.executeA2ATask).not.toHaveBeenCalled();
    });

    it('verifies valid incoming A2A requests and signs the returned artifact', async () => {
      const mockOrchestrator = {
        executeA2ATask: vi.fn().mockResolvedValue({
          success: true,
          output: { parsed: { status: 'ok' } },
          escrowStatus: 'released',
          metrics: { latencyMs: 15, costUsd: 0.05 },
        }),
      } as any;

      const capability = new A2ACapability({
        orchestrator: mockOrchestrator,
        metaToolManager: {} as any,
        metaToolRegistry,
      });

      const providerCore = new AgentCore({
        delayFloorHours: 0.5,
        registry: { all: () => [], stopAll: vi.fn() } as any,
        signer,
        triage,
        executor: {} as any,
        quality: {} as any,
        ledger: {} as any,
        learning: {} as any,
        budget: {} as any,
        agentId: 'agent-provider',
        workerId: 'worker-provider',
        a2aCapability: capability,
      });

      const clientIdentity = AgentIdentity.create('agent-client');
      const validRequest = clientIdentity.signA2ARequest({
        taskId: 'valid-task-42',
        toolId: 'fast-json-parser',
        costUsd: 0.1,
        clientAgentId: 'agent-client',
        providerAgentId: 'agent-provider',
      });

      const result = await providerCore.handleIncomingA2ARequest(validRequest);

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ parsed: { status: 'ok' } });
      expect(mockOrchestrator.executeA2ATask).toHaveBeenCalledWith(validRequest);

      // Verify the returned artifact is signed by provider
      expect(result.signature).toBeDefined();
      expect(result.signature?.startsWith('ed25519:')).toBe(true);
      expect(result.signerPubkey).toBe(providerCore.identity.getPublicKeyPem());
    });

    it('delegates task across real HTTP network transport between two AgentCore instances with discovery', async () => {
      const PORT = 41299;
      const bobIdentity = AgentIdentity.create('bob-node');
      const aliceIdentity = AgentIdentity.create('alice-node');

      const bobOrchestrator = {
        executeA2ATask: vi.fn().mockResolvedValue({
          success: true,
          output: { result: 'computed-by-bob' },
          escrowStatus: 'released',
          metrics: { latencyMs: 20, costUsd: 0.1 },
        }),
      } as any;

      const bobCapability = new A2ACapability({
        orchestrator: bobOrchestrator,
        metaToolManager: {} as any,
        metaToolRegistry,
        identity: bobIdentity,
      });

      const bobCore = new AgentCore({
        delayFloorHours: 0.5,
        registry: { all: () => [], stopAll: vi.fn() } as any,
        signer,
        triage,
        executor: {} as any,
        quality: {} as any,
        ledger: {} as any,
        learning: {} as any,
        budget: {} as any,
        agentId: 'bob-node',
        workerId: 'bob-worker',
        a2aCapability: bobCapability,
        identity: bobIdentity,
      });

      // Start Bob's HTTP Transport server
      const bobHttpTransport = new A2AHttpTransport({
        identity: bobIdentity,
        handler: bobCore,
        agentCardOptions: {
          name: 'Bob Remote Node',
          endpoints: {
            http: `http://127.0.0.1:${PORT}/a2a`,
            wellKnown: `http://127.0.0.1:${PORT}/.well-known/agent-card.json`,
          },
        },
      });

      await bobHttpTransport.start(PORT, '127.0.0.1');

      try {
        // Setup Alice with discovery & peer registry
        const alicePeerRegistry = new PeerRegistry();
        const aliceHttpTransport = new A2AHttpTransport({
          identity: aliceIdentity,
          handler: { handleIncomingA2ARequest: vi.fn() },
        });

        // Alice discovers Bob via well-known URL
        const discovery = await alicePeerRegistry.discoverPeerFromUrl(`http://127.0.0.1:${PORT}`);
        expect(discovery.success).toBe(true);
        expect(discovery.peer?.agentId).toBe('bob-node');

        const aliceCapability = new A2ACapability({
          orchestrator: {} as any,
          metaToolManager: {} as any,
          metaToolRegistry,
          identity: aliceIdentity,
          peerRegistry: alicePeerRegistry,
          httpTransport: aliceHttpTransport,
          initialBalance: 100,
        });

        const aliceCore = new AgentCore({
          delayFloorHours: 0.5,
          registry: { all: () => [], stopAll: vi.fn() } as any,
          signer,
          triage,
          executor: {} as any,
          quality: {} as any,
          ledger: {} as any,
          learning: {} as any,
          budget: {} as any,
          agentId: 'alice-node',
          workerId: 'alice-worker',
          a2aCapability: aliceCapability,
          identity: aliceIdentity,
          peerRegistry: alicePeerRegistry,
          httpTransport: aliceHttpTransport,
        });

        // Alice requests service from Bob via requestServiceFromPeer
        const outcome = await aliceCore.requestServiceFromPeer(
          'bob-node',
          'fast-json-parser',
          { query: 'test-remote' },
          0.5,
        );

        expect(outcome.success).toBe(true);
        expect(outcome.output).toEqual({ result: 'computed-by-bob' });
        expect(bobOrchestrator.executeA2ATask).toHaveBeenCalled();
      } finally {
        await bobHttpTransport.stop();
      }
    });
  });
});
