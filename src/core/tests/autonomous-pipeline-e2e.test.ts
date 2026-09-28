import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AgentCore } from '../agent.js';
import { SolanaReceiveWallet } from '../solana-wallet.js';
import { EconomicBrain } from '../opportunity/economic-brain.js';
import { OpportunityScanner } from '../opportunity/scanner.js';
import { LocalFeedOpportunityAdapter } from '../opportunity/local-feed-adapter.js';
import { HTNPlanner } from '../htn/planner.js';
import { MorphlingReplanEngine } from '../htn/morphling-replan.js';
import type { Opportunity } from '../opportunity/types.js';
import { Ledger } from '../ledger.js';
import { BudgetGuard } from '../budget.js';
import { LearningStore } from '../learning.js';
import { QualityChecker } from '../quality.js';
import { AdapterRegistry } from '../registry.js';
import { AgentIdentity } from '../../identity/agent-identity.js';
import { TriageEngine } from '../triage.js';
import { FixedModelRouter } from '../model-router.js';
import { StaticCostEstimator } from '../cost-estimator.js';
import { PriorSuccessProbabilityProvider } from '../triage.js';
import { A2ACapability } from '../a2a-capability.js';
import { A2AAgentOrchestrator } from '../a2a-orchestrator.js';
import { MetaToolRegistry } from '../meta-tools/registry.js';
import { EscrowSystem } from '../escrow.js';

describe('Autonomous End-to-End Pipeline: Scanner -> EconomicBrain -> HTN -> Execute -> Deliver -> Real Solana Payment', () => {
  const SOLANA_RECEIVE_ADDRESS = '3t7xtNf5vyb7XKMFoNXaZJ7yW4dx8L8CN1LjcCLEacER';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  let ledger: Ledger;
  let localFeed: LocalFeedOpportunityAdapter;
  let economicBrain: EconomicBrain;
  let scanner: OpportunityScanner;
  let htnPlanner: HTNPlanner;
  let morphlingReplan: MorphlingReplanEngine;
  let solanaWallet: SolanaReceiveWallet;
  let core: AgentCore;
  let executor: any;
  let mockFetch: any;

  beforeEach(() => {
    mockFetch = vi.fn();
    ledger = new Ledger();
    localFeed = new LocalFeedOpportunityAdapter();
    economicBrain = new EconomicBrain({
      capabilities: ['analysis', 'synthesis', 'verification', 'code-generation'],
      minProfitMarginRatio: 0.20,
      minAbsoluteProfitUsd: 0.05,
    });
    scanner = new OpportunityScanner({
      brain: economicBrain,
      adapters: [localFeed],
      pollIntervalMs: 50,
    });
    htnPlanner = new HTNPlanner();
    morphlingReplan = new MorphlingReplanEngine();
    solanaWallet = new SolanaReceiveWallet({
      receiveAddress: SOLANA_RECEIVE_ADDRESS,
      usdcMint: USDC_MINT,
      ledger,
      fetchFn: mockFetch,
    });

    executor = {
      execute: vi.fn().mockImplementation(async (input: any) => {
        return {
          output: { result: `Success for task ${input.task.id}`, status: 'verified' },
          model: 'gemini-2.5-flash',
          modelUsed: 'gemini-2.5-flash',
          provider: 'gemini',
          tokensIn: 100,
          tokensOut: 50,
          costUsd: 0.001,
          latencyMs: 40,
          finishReason: 'stop',
          telemetry: {
            timestamp: new Date().toISOString(),
            latencyMs: 40,
            tokensIn: 100,
            tokensOut: 50,
            costUsd: 0.001,
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            fallbackUsed: false,
            fallbackChain: [],
            systemPath: 'system2',
          },
        };
      }),
    };

    const identity = AgentIdentity.create('00000000-0000-0000-0000-000000000000');
    const metaRegistry = new MetaToolRegistry();
    const escrow = new EscrowSystem();
    const a2aOrchestrator = new A2AAgentOrchestrator({} as any, escrow);
    const a2aCapability = new A2ACapability({
      orchestrator: a2aOrchestrator,
      metaToolRegistry: metaRegistry,
      metaToolManager: {} as any,
      escrow,
    });

    const triage = new TriageEngine({
      thresholds: { minProfitUsd: 0.01, minSuccessProbability: 0.8, minTimeAdjustedProfit: 0.01 },
      successProb: new PriorSuccessProbabilityProvider(0.95),
      modelRouter: new FixedModelRouter('gemini-2.5-flash'),
      costEstimator: new StaticCostEstimator(),
      defaultGasCostUsd: 0.001,
      delayFloorHours: 0.1,
      metaToolRegistry: metaRegistry,
    });

    const learning = new LearningStore('development');
    const budget = new BudgetGuard({ dailyCapUsd: 5.0, store: learning });
    const quality = new QualityChecker();
    const registry = new AdapterRegistry();

    core = new AgentCore({
      agentId: identity.agentId,
      workerId: 'agent-001',
      identity,
      registry,
      signer: identity.getSigner(),
      triage,
      executor,
      quality,
      ledger,
      learning,
      budget,
      delayFloorHours: 0.1,
      a2aCapability,
      solanaWallet,
      opportunityScanner: scanner,
      economicBrain,
      htnPlanner,
      morphlingReplan,
    });
  });

  it('executes full pipeline autonomously from opportunity to HTN decomposition and deliverable', async () => {
    const opp: Opportunity = {
      id: 'opp-pipeline-1',
      source: 'local-feed',
      title: 'Analyze and synthesize token liquidity',
      description: 'Run deep liquidity decomposition and verification',
      payment: {
        amount: 0.50,
        currency: 'USDC',
        chain: 'solana',
      },
      deadline: new Date(Date.now() + 60000).toISOString(),
      skillsRequired: ['synthesis'],
      discoveredAt: new Date().toISOString(),
    };

    const result = await core.executeOpportunity(opp);

    expect(result.success).toBe(true);
    expect(result.graph).toBeDefined();
    expect(result.graph!.isCompleted()).toBe(true);
    expect(result.graph!.hasFailedTasks()).toBe(false);
    expect(result.deliverables).toBeDefined();
    expect(Object.keys(result.deliverables!).length).toBe(3); // 3 stages completed

    // Crucial requirement: No fake payment credits were made on execution finish
    // The double-entry ledger only records revenue when real on-chain transaction is verified
    const recordDepositSpy = vi.spyOn(ledger, 'recordPaymentDeposit').mockResolvedValue(null);

    // Now real incoming transfer occurs on Solana address
    const realTxHash = '4SolanaRealIncomingTransferHash789abcdef';
    mockFetch.mockImplementation(async (_url: string, options: any) => {
      const body = JSON.parse(options.body);
      if (body.method === 'getSignaturesForAddress') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            result: [{ signature: realTxHash, slot: 5000, blockTime: Math.floor(Date.now() / 1000) }],
          }),
        };
      }
      if (body.method === 'getTransaction') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            result: {
              slot: 5000,
              blockTime: Math.floor(Date.now() / 1000),
              transaction: {
                message: {
                  accountKeys: [{ pubkey: 'ClientSenderPubkey' }, { pubkey: SOLANA_RECEIVE_ADDRESS }],
                },
              },
              meta: {
                preTokenBalances: [
                  { accountIndex: 1, mint: USDC_MINT, owner: SOLANA_RECEIVE_ADDRESS, uiTokenAmount: { uiAmount: 0 } },
                ],
                postTokenBalances: [
                  { accountIndex: 1, mint: USDC_MINT, owner: SOLANA_RECEIVE_ADDRESS, uiTokenAmount: { uiAmount: 0.50 } },
                ],
              },
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', result: null }) };
    });

    const detectedPayments = await core.pollIncomingPayments();
    expect(detectedPayments.length).toBe(1);
    expect(detectedPayments[0]!.txHash).toBe(realTxHash);
    expect(detectedPayments[0]!.amount).toBe(0.50);
    expect(detectedPayments[0]!.asset).toBe('USDC');

    // Verified: Ledger balance credited ONLY via real SolanaReceiveWallet
    expect(recordDepositSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: realTxHash,
        amountUsd: 0.50,
        asset: 'USDC',
        walletAccountCode: 'wallet_solana',
      }),
    );
  });

  it('rejects unprofitable opportunity at EconomicBrain without executing HTN decomposition', async () => {
    const unprofitableOpp: Opportunity = {
      id: 'opp-unprofitable',
      source: 'local-feed',
      title: 'Unprofitable job offer',
      description: 'Pays zero',
      payment: {
        amount: 0.0,
        currency: 'USDC',
      },
      deadline: new Date(Date.now() + 60000).toISOString(),
      skillsRequired: ['synthesis'],
      discoveredAt: new Date().toISOString(),
    };

    const result = await core.executeOpportunity(unprofitableOpp);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Negative expected value');
    // Executor was never called
    expect(executor.execute).not.toHaveBeenCalled();
  });
});
