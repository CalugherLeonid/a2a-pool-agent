import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReputationSystem } from '../reputation.js';
import { DynamicPricingEngine } from '../pricing-engine.js';
import { EscrowSystem } from '../escrow.js';
import { TelemetryCollector } from '../../telemetry/metrics.js';
import { AgentIdentity } from '../../identity/agent-identity.js';
import { DynamicAgentCardManager } from '../dynamic-agent-card.js';
import { A2AAgentOrchestrator } from '../a2a-orchestrator.js';
import { AutonomousAgent } from '../agent.js';
import { MetaToolRegistry } from '../meta-tools/registry.js';
import type { MetaToolManager } from '../meta-tools/manager.js';
import { EvalPack } from '../eval-pack.js';

describe('ETAPA 7 – Escrow M2M + Sistem de Reputație + Dynamic Pricing', () => {
  let reputationSystem: ReputationSystem;
  let telemetry: TelemetryCollector;
  let escrow: EscrowSystem;

  beforeEach(() => {
    reputationSystem = new ReputationSystem();
    telemetry = new TelemetryCollector();
    escrow = new EscrowSystem(3, telemetry);
  });

  describe('1. Reputation Calculation Logic & History', () => {
    it('initializes agents with baseline neutral score 1.0 (optimistic initialization)', () => {
      const score = reputationSystem.getScore('agent-unknown');
      expect(score).toBe(1.0);
    });

    it('correctly weighs delivery success, deadlines, eval scores and ratchet decisions', () => {
      // Perfect delivery: on-time, evalScore=1.0, ratchet=true
      reputationSystem.recordFeedback({
        taskId: 'task-1',
        agentId: 'agent-alice',
        success: true,
        latencyMs: 500,
        deadlineMs: 2000,
        evalScore: 1.0,
        ratchetAccepted: true,
      });

      const highSummary = reputationSystem.getSummary('agent-alice');
      expect(highSummary.totalDeliveries).toBe(1);
      expect(highSummary.successfulDeliveries).toBe(1);
      expect(highSummary.deadlineAdherenceRatio).toBe(1.0);
      expect(highSummary.reputationScore).toBeGreaterThanOrEqual(0.95);

      // Failed delivery on agent-bob: missed deadline, evalScore=0.2, ratchet=false
      reputationSystem.recordFeedback({
        taskId: 'task-2',
        agentId: 'agent-bob',
        success: false,
        latencyMs: 3500,
        deadlineMs: 2000,
        evalScore: 0.2,
        ratchetAccepted: false,
      });

      const lowSummary = reputationSystem.getSummary('agent-bob');
      expect(lowSummary.totalDeliveries).toBe(1);
      expect(lowSummary.successfulDeliveries).toBe(0);
      expect(lowSummary.deadlineAdherenceRatio).toBe(0.0);
      expect(lowSummary.reputationScore).toBeLessThan(0.4);
    });

    it('smooths score across multiple tasks with rolling window history', () => {
      for (let i = 0; i < 5; i++) {
        reputationSystem.recordFeedback({
          taskId: `task-succ-${i}`,
          agentId: 'agent-carol',
          success: true,
          latencyMs: 400,
          deadlineMs: 1000,
          evalScore: 0.95,
          ratchetAccepted: true,
        });
      }

      expect(reputationSystem.getScore('agent-carol')).toBeGreaterThan(0.9);

      // Single failure slightly drops score but doesn't completely crash it
      reputationSystem.recordFeedback({
        taskId: 'task-fail-1',
        agentId: 'agent-carol',
        success: false,
        latencyMs: 600,
        deadlineMs: 1000,
        evalScore: 0.3,
        ratchetAccepted: false,
      });

      const scoreAfter1Fail = reputationSystem.getScore('agent-carol');
      expect(scoreAfter1Fail).toBeLessThan(0.95);
      expect(scoreAfter1Fail).toBeGreaterThan(0.7);

      const history = reputationSystem.getHistory('agent-carol');
      expect(history.length).toBe(6);
      expect(history[0]?.taskId).toBe('task-fail-1');
      expect(history[0]?.success).toBe(false);
    });

    it('properly records and accounts for timeouts (timedOut: true)', () => {
      reputationSystem.recordFeedback({
        taskId: 'timeout-task-1',
        agentId: 'slow-agent',
        success: false,
        timedOut: true,
        metDeadline: false,
        latencyMs: 10000,
        deadlineMs: 5000,
        evalScore: 0.0,
      });

      const summary = reputationSystem.getSummary('slow-agent');
      expect(summary.timedOutDeliveries).toBe(1);
      expect(summary.successfulDeliveries).toBe(0);
      expect(summary.reputationScore).toBeLessThan(0.4);

      const history = reputationSystem.getHistory('slow-agent');
      expect(history[0]?.timedOut).toBe(true);
    });

    it('triggers registered onUpdate listeners with updated score and record', () => {
      const listener = vi.fn();
      const unsubscribe = reputationSystem.onUpdate(listener);

      reputationSystem.recordFeedback({
        taskId: 'listener-task-1',
        agentId: 'agent-listen',
        success: true,
        latencyMs: 100,
        deadlineMs: 1000,
        evalScore: 1.0,
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        'agent-listen',
        expect.any(Number),
        expect.objectContaining({ agentId: 'agent-listen' }),
        expect.objectContaining({ taskId: 'listener-task-1' }),
      );

      unsubscribe();
      reputationSystem.recordFeedback({
        taskId: 'listener-task-2',
        agentId: 'agent-listen',
        success: true,
      });
      // Listener should not be called again after unsubscribe
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. Dynamic Pricing Engine & Card Integration', () => {
    it('applies a premium up to maxIncreasePercent for high reputation (> 0.90)', () => {
      const pricing = new DynamicPricingEngine({
        basePriceUsd: 1.0,
        baseMinRewardUsd: 0.5,
        highReputationThreshold: 0.90,
        maxIncreasePercent: 0.10, // +10%
      });

      // Perfect reputation 1.0 -> should yield max increase (+10%)
      const calc1 = pricing.calculatePricing(1.0);
      expect(calc1.multiplier).toBe(1.10);
      expect(calc1.defaultCostUsd).toBe(1.10);
      expect(calc1.minAcceptedRewardUsd).toBe(0.55);
      expect(calc1.reason).toContain('high_reputation_premium');

      // Nominal reputation 0.80 -> baseline
      const calc2 = pricing.calculatePricing(0.80);
      expect(calc2.multiplier).toBe(1.0);
      expect(calc2.defaultCostUsd).toBe(1.0);
    });

    it('applies discount for low reputation (< 0.50)', () => {
      const pricing = new DynamicPricingEngine({
        basePriceUsd: 2.0,
        baseMinRewardUsd: 1.0,
        lowReputationThreshold: 0.50,
        maxDiscountPercent: 0.15, // -15%
      });

      // Low reputation 0.0 -> max discount (-15%)
      const calc = pricing.calculatePricing(0.0);
      expect(calc.multiplier).toBe(0.85);
      expect(calc.defaultCostUsd).toBe(1.70);
      expect(calc.minAcceptedRewardUsd).toBe(0.85);
      expect(calc.reason).toContain('low_reputation_discount');
    });

    it('respects configured minFloorUsd and maxCeilingUsd', () => {
      const pricing = new DynamicPricingEngine({
        basePriceUsd: 0.005,
        baseMinRewardUsd: 0.005,
        minFloorUsd: 0.02,
        maxCeilingUsd: 5.0,
      });

      const calc = pricing.calculatePricing(0.1);
      expect(calc.defaultCostUsd).toBe(0.02);
      expect(calc.minAcceptedRewardUsd).toBe(0.02);
    });

    it('allows updating rules dynamically via updateRules', () => {
      const pricing = new DynamicPricingEngine({
        basePriceUsd: 1.0,
        baseMinRewardUsd: 0.5,
      });

      pricing.updateRules({
        highReputationThreshold: 0.85,
        maxIncreasePercent: 0.20,
      });

      const calc = pricing.calculatePricing(1.0);
      expect(calc.multiplier).toBe(1.20);
      expect(calc.defaultCostUsd).toBe(1.20);
    });
  });

  describe('3. Dynamic Agent Card Reflection & Versioning', () => {
    it('pulls reputation score into Agent Card performanceMetrics and adjusts pricing dynamically', () => {
      const identity = AgentIdentity.create('agent-pricing-card');
      const pricing = new DynamicPricingEngine({
        basePriceUsd: 1.0,
        baseMinRewardUsd: 0.5,
        maxIncreasePercent: 0.10,
      });

      // Seed reputation system with top-tier performance
      for (let i = 0; i < 3; i++) {
        reputationSystem.recordFeedback({
          taskId: `init-${i}`,
          agentId: identity.agentId,
          success: true,
          latencyMs: 100,
          deadlineMs: 1000,
          evalScore: 1.0,
          ratchetAccepted: true,
        });
      }

      const cardManager = new DynamicAgentCardManager({
        identity,
        reputationSystem,
        pricingEngine: pricing,
        telemetry,
      });

      const card = cardManager.getCurrentCard();
      expect(card.performanceMetrics?.reputationScore).toBeGreaterThanOrEqual(0.95);
      expect(card.pricing.defaultCostUsd).toBeGreaterThanOrEqual(1.05);

      // Verify cryptographic signature is valid on the card
      const signed = cardManager.getSignedAgentCard();
      const verified = AgentIdentity.verifyAgentCard(signed);
      expect(verified.valid).toBe(true);
    });

    it('automatically regenerates and re-signs Agent Card when reputation updates via listener', () => {
      const identity = AgentIdentity.create('agent-auto-update');
      const cardManager = new DynamicAgentCardManager({
        identity,
        reputationSystem,
        telemetry,
      });

      const initialVersion = cardManager.getVersion();
      const initialBuild = cardManager.getBuildNumber();

      // Trigger reputation drop
      reputationSystem.recordFeedback({
        taskId: 'fail-task-auto',
        agentId: identity.agentId,
        success: false,
        metDeadline: false,
        evalScore: 0.1,
        ratchetAccepted: false,
      });

      // Card manager should have automatically updated and bumped version
      expect(cardManager.getVersion()).not.toBe(initialVersion);
      expect(cardManager.getBuildNumber()).toBeGreaterThan(initialBuild);
      const updatedCard = cardManager.getCurrentCard();
      expect(updatedCard.performanceMetrics?.reputationScore).toBeLessThan(0.8);

      // Verify new signature
      const signed = cardManager.getSignedAgentCard();
      expect(AgentIdentity.verifyAgentCard(signed).valid).toBe(true);
    });

    it('regenerates and re-signs Agent Card when updatePricing is invoked', () => {
      const identity = AgentIdentity.create('agent-price-update');
      const cardManager = new DynamicAgentCardManager({
        identity,
        reputationSystem,
      });

      const res = cardManager.updatePricing({
        basePriceUsd: 2.50,
        baseMinRewardUsd: 1.25,
        reason: 'inflation_adjustment',
      });

      // At reputation 1.0 with default 10% premium: 2.50 * 1.10 = 2.75, 1.25 * 1.10 = 1.375
      expect(res.card.pricing.defaultCostUsd).toBe(2.75);
      expect(res.card.pricing.minAcceptedRewardUsd).toBe(1.375);
      expect(AgentIdentity.verifyAgentCard(res.signedCard).valid).toBe(true);
    });
  });

  describe('4. Complete M2M Escrow Flow: Lock, Release, Refund, Telemetry & Queries', () => {
    it('records telemetry for locked, released, and refunded escrow events with peerId and amount', async () => {
      // 1. Lock funds
      const lockRes = await escrow.lockFunds({
        taskId: 'escrow-task-1',
        amount: 2.50,
        from: 'client-agent',
        to: 'provider-agent',
      });
      expect(lockRes.success).toBe(true);

      let metrics = telemetry.getMetrics();
      expect(metrics.escrowLockedCount).toBe(1);
      expect(metrics.totalEscrowLockedUsd).toBe(2.50);

      // Verify query methods
      const rec = escrow.getRecordByTaskId('escrow-task-1');
      expect(rec).toBeDefined();
      expect(rec?.amount).toBe(2.50);
      expect(rec?.to).toBe('provider-agent');
      expect(rec?.status).toBe('LOCKED');

      // 2. Release funds
      const relRes = await escrow.releaseFunds('escrow-task-1', lockRes.escrowId!);
      expect(relRes.success).toBe(true);

      metrics = telemetry.getMetrics();
      expect(metrics.escrowReleasedCount).toBe(1);
      expect(metrics.totalEscrowReleasedUsd).toBe(2.50);
      expect(escrow.getRecordById(lockRes.escrowId!)?.status).toBe('RELEASED');

      // 3. Test refund on a separate task
      const lock2 = await escrow.lockFunds({
        taskId: 'escrow-task-2',
        amount: 1.75,
        from: 'client-agent',
        to: 'provider-agent',
      });
      expect(lock2.success).toBe(true);

      const refundRes = await escrow.refundFunds(
        'escrow-task-2',
        lock2.escrowId!,
        'deadline_exceeded',
      );
      expect(refundRes.success).toBe(true);

      metrics = telemetry.getMetrics();
      expect(metrics.escrowRefundedCount).toBe(1);
      expect(metrics.totalEscrowRefundedUsd).toBe(1.75);
      expect(escrow.getRecordByTaskId('escrow-task-2')?.status).toBe('REFUNDED');

      // Verify getAllRecords returns all records
      expect(escrow.getAllRecords().length).toBe(2);
    });

    it('rejects invalid lock amounts (<= 0) and handles duplicate task idempotency', async () => {
      const zeroLock = await escrow.lockFunds({
        taskId: 'zero-task',
        amount: 0,
        from: 'a',
        to: 'b',
      });
      expect(zeroLock.success).toBe(false);
      expect(zeroLock.error).toContain('greater than zero');

      const lock1 = await escrow.lockFunds({
        taskId: 'dup-task',
        amount: 1.0,
        from: 'a',
        to: 'b',
      });
      expect(lock1.success).toBe(true);

      // Locking same taskId while LOCKED is idempotent
      const lockDup = await escrow.lockFunds({
        taskId: 'dup-task',
        amount: 1.0,
        from: 'a',
        to: 'b',
      });
      expect(lockDup.success).toBe(true);
      expect(lockDup.escrowId).toBe(lock1.escrowId);
    });
  });

  describe('5. Orchestrated End-to-End M2M Execution with Escrow and Reputation', () => {
    it('releases escrow and increases provider reputation on successful task execution', async () => {
      const metaToolRegistry = new MetaToolRegistry();
      metaToolRegistry.register({
        id: 'string-reverser',
        name: 'String Reverser',
        description: 'Reverses input strings',
        sourceCode: `return "gnilhprom";`,
        language: 'javascript',
        parametersSchema: { type: 'object' },
      });

      const metaToolManager = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: 'gnilhprom',
          evaluationScore: 1.0,
          ratchetDecision: 'accepted',
          metrics: { latencyMs: 50 },
          toolVersionUsed: 1,
        }),
      } as unknown as MetaToolManager;

      const orchestrator = new A2AAgentOrchestrator(metaToolManager, escrow, reputationSystem);
      const autonomousAgent = new AutonomousAgent(
        'client-agent',
        orchestrator,
        metaToolRegistry,
        100,
        reputationSystem,
      );

      const result = await autonomousAgent.requestServiceFromPeer(
        'provider-peer-1',
        'string-reverser',
        { text: 'morphling' },
        0.50,
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe('gnilhprom');
      expect(autonomousAgent.getBalance()).toBe(99.50);

      // Verify provider-peer-1 gained positive reputation
      const providerScore = reputationSystem.getScore('provider-peer-1');
      expect(providerScore).toBeGreaterThan(0.9);

      // Verify escrow released telemetry
      const metrics = telemetry.getMetrics();
      expect(metrics.escrowLockedCount).toBe(1);
      expect(metrics.escrowReleasedCount).toBe(1);
      expect(metrics.escrowRefundedCount).toBe(0);
    });

    it('refunds escrow and penalizes reputation when meta-tool fails or gets rejected', async () => {
      const metaToolRegistry = new MetaToolRegistry();
      metaToolRegistry.register({
        id: 'failing-tool',
        name: 'Failing Tool',
        description: 'Always throws',
        sourceCode: `throw new Error("Deliberate failure");`,
        language: 'javascript',
        parametersSchema: { type: 'object' },
      });

      const metaToolManager = {
        execute: vi.fn().mockResolvedValue({
          success: false,
          output: null,
          error: 'Execution failed',
          evaluationScore: 0.1,
          ratchetDecision: 'rejected',
          metrics: { latencyMs: 60 },
          toolVersionUsed: 1,
        }),
      } as unknown as MetaToolManager;

      const orchestrator = new A2AAgentOrchestrator(metaToolManager, escrow, reputationSystem);
      const autonomousAgent = new AutonomousAgent(
        'client-agent',
        orchestrator,
        metaToolRegistry,
        100,
        reputationSystem,
      );

      const result = await autonomousAgent.requestServiceFromPeer(
        'faulty-provider',
        'failing-tool',
        {},
        0.75,
      );

      expect(result.success).toBe(false);
      // Wallet was refunded (not deducted)
      expect(autonomousAgent.getBalance()).toBe(100);

      // Faulty provider reputation is penalized
      const providerScore = reputationSystem.getScore('faulty-provider');
      expect(providerScore).toBeLessThan(0.4);

      // Escrow telemetry reflects lock + refund
      const metrics = telemetry.getMetrics();
      expect(metrics.escrowLockedCount).toBe(1);
      expect(metrics.escrowRefundedCount).toBe(1);
      expect(metrics.totalEscrowRefundedUsd).toBe(0.75);
    });

    it('automatically refunds escrow and updates reputation on execution timeout', async () => {
      const metaToolManager = {
        execute: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 500)),
        ),
      } as unknown as MetaToolManager;

      const orchestrator = new A2AAgentOrchestrator(metaToolManager, escrow, reputationSystem);

      const res = await orchestrator.executeTask({
        taskId: 'timeout-task-e2e',
        toolId: 'slow-tool',
        parameters: {},
        costUsd: 1.50,
        clientAgentId: 'client-1',
        providerAgentId: 'slow-peer',
        timeoutMs: 50, // very tight timeout
      });

      expect(res.success).toBe(false);
      expect(res.escrowStatus).toBe('refunded');
      expect(res.error).toContain('timed out');

      // Slow peer reputation should have a timeout recorded
      const slowSummary = reputationSystem.getSummary('slow-peer');
      expect(slowSummary.timedOutDeliveries).toBe(1);
    });

    it('refunds escrow if EvalPack verification fails on delivery', async () => {
      const metaToolManager = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: 'malicious_payload',
          ratchetDecision: 'accepted',
          evaluationScore: 1.0,
        }),
      } as unknown as MetaToolManager;

      const evalPack = new EvalPack();
      evalPack.addRule({
        id: 'no-malicious',
        description: 'Output must not be malicious',
        evaluate: (result) => !result.stdout?.includes('malicious'),
      });

      const orchestrator = new A2AAgentOrchestrator(
        metaToolManager,
        escrow,
        reputationSystem,
        evalPack,
      );

      const res = await orchestrator.executeTask({
        taskId: 'evalpack-fail-task',
        toolId: 'untrusted-tool',
        parameters: {},
        costUsd: 2.0,
        clientAgentId: 'client-1',
        providerAgentId: 'suspicious-peer',
      });

      expect(res.success).toBe(false);
      expect(res.escrowStatus).toBe('refunded');
      expect(res.error).toContain('EvalPack');
    });

    it('enforces zero-trust cryptographic signature verification on incoming A2A requests', async () => {
      const clientIdentity = AgentIdentity.create('valid-client');
      const providerIdentity = AgentIdentity.create('trusted-provider');

      const metaToolManager = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: 'signed_success',
          ratchetDecision: 'accepted',
          evaluationScore: 1.0,
        }),
      } as unknown as MetaToolManager;

      const orchestrator = new A2AAgentOrchestrator(
        metaToolManager,
        escrow,
        reputationSystem,
        undefined,
        providerIdentity,
      );

      // Tampered request with bad signature
      const validReq = clientIdentity.signA2ARequest({
        taskId: 'sig-test-task',
        toolId: 'math',
        parameters: {},
        costUsd: 0.50,
        clientAgentId: clientIdentity.agentId,
        providerAgentId: providerIdentity.agentId,
      });

      const tamperedReq = {
        ...validReq,
        signature: 'invalid-tampered-signature.foo.bar',
      };

      const result = await orchestrator.executeTask(tamperedReq);
      expect(result.success).toBe(false);
      expect(result.escrowStatus).toBe('failed');
      expect(result.error).toContain('Cryptographic verification failed');
    });
  });
});

