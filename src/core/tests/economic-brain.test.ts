import { describe, expect, it, beforeEach } from 'vitest';
import { EconomicBrain } from '../opportunity/economic-brain.js';
import type { Opportunity } from '../opportunity/types.js';
import { ReputationSystem } from '../reputation.js';

describe('EconomicBrain - Quantitative Economic Gatekeeper', () => {
  let brain: EconomicBrain;
  let reputationSystem: ReputationSystem;

  beforeEach(() => {
    reputationSystem = new ReputationSystem();
    brain = new EconomicBrain({
      capabilities: ['analysis', 'synthesis', 'verification', 'code-generation'],
      minProfitMarginRatio: 0.20, // 20% margin minimum
      minAbsoluteProfitUsd: 0.05,
      minReputationScore: 0.70,
      maxConcurrentCapacity: 5,
      minLeadTimeMs: 5000,
      reputationSystem,
    });
  });

  const baseOpportunity: Opportunity = {
    id: 'opp-1',
    source: 'market-feed',
    title: 'Analyze market liquidity pool',
    description: 'Provide quantitative liquidity depth metrics',
    payment: {
      amount: 0.50,
      currency: 'USDC',
      chain: 'solana',
    },
    deadline: new Date(Date.now() + 60000).toISOString(),
    skillsRequired: ['analysis'],
    discoveredAt: new Date().toISOString(),
  };

  it('ACCEPT case: high-confidence profitable opportunity passing all economic gates', async () => {
    const decision = await brain.evaluate(baseOpportunity, 1);

    expect(decision.action).toBe('ACCEPT');
    expect(decision.permissionGranted).toBe(true);
    expect(decision.breakdown.skillMatch).toBe(true);
    expect(decision.breakdown.profitabilityPassed).toBe(true);
    expect(decision.breakdown.deadlineFeasible).toBe(true);
    expect(decision.breakdown.capacityAvailable).toBe(true);
    expect(decision.expectedProfit).toBeGreaterThan(0.05);
    expect(decision.roiPercentage).toBeGreaterThan(20);
    expect(decision.justification).toContain('ACCEPTED');
  });

  it('REJECT case: agent lacks required sovereign capability', async () => {
    const opp: Opportunity = {
      ...baseOpportunity,
      id: 'opp-unsupported',
      skillsRequired: ['unsupported-quantum-teleportation'],
    };

    const decision = await brain.evaluate(opp, 0);
    expect(decision.action).toBe('REJECT');
    expect(decision.permissionGranted).toBe(false);
    expect(decision.breakdown.skillMatch).toBe(false);
    expect(decision.justification).toContain('lacks required skills');
  });

  it('REJECT case: negative expected value / unprofitable payout', async () => {
    const opp: Opportunity = {
      ...baseOpportunity,
      id: 'opp-negative-ev',
      payment: {
        amount: 0.001, // Way below estimated cost (~0.003)
        currency: 'USDC',
      },
    };

    const decision = await brain.evaluate(opp, 0);
    expect(decision.action).toBe('REJECT');
    expect(decision.permissionGranted).toBe(false);
    expect(decision.breakdown.profitabilityPassed).toBe(false);
    expect(decision.justification).toContain('Negative expected value');
  });

  it('REJECT case: expired or infeasible deadline', async () => {
    const opp: Opportunity = {
      ...baseOpportunity,
      id: 'opp-expired',
      deadline: new Date(Date.now() - 5000).toISOString(), // 5s in past
    };

    const decision = await brain.evaluate(opp, 0);
    expect(decision.action).toBe('REJECT');
    expect(decision.permissionGranted).toBe(false);
    expect(decision.breakdown.deadlineFeasible).toBe(false);
    expect(decision.justification).toContain('Deadline is expired');
  });

  it('REJECT case: requester reputation below minimum threshold', async () => {
    const badRequesterId = 'agent-malicious-peer';
    // Record multiple failures to tank reputation
    for (let i = 0; i < 5; i++) {
      reputationSystem.recordFeedback({
        taskId: `bad-task-${i}`,
        agentId: badRequesterId,
        success: false,
        latencyMs: 50000,
        deadlineMs: 10000,
        evalScore: 0.1,
        ratchetAccepted: false,
      });
    }

    const opp: Opportunity = {
      ...baseOpportunity,
      id: 'opp-bad-reputation',
      requesterAgentId: badRequesterId,
    };

    const decision = await brain.evaluate(opp, 0);
    expect(decision.action).toBe('REJECT');
    expect(decision.permissionGranted).toBe(false);
    expect(decision.breakdown.reputationPassed).toBe(false);
    expect(decision.justification).toContain('Requester reputation score');
  });

  it('COUNTER_OFFER case: payout covers base cost but fails minimum profit margin', async () => {
    const opp: Opportunity = {
      ...baseOpportunity,
      id: 'opp-low-margin',
      payment: {
        amount: 0.006, // Slightly above cost 0.003, but net profit ~0.003 < 0.05 min
        currency: 'USDC',
      },
    };

    const decision = await brain.evaluate(opp, 0);
    expect(decision.action).toBe('COUNTER_OFFER');
    expect(decision.permissionGranted).toBe(false); // Only ACCEPT grants execution permission
    expect(decision.counterOfferPrice).toBeDefined();
    expect(decision.counterOfferPrice!).toBeGreaterThan(0.006);
    expect(decision.justification).toContain('COUNTER_OFFER: Offered payout');
  });

  it('COUNTER_OFFER case: workload capacity saturated triggers surge counter-offer', async () => {
    // Current workload = 5 equals maxConcurrentCapacity (5)
    const decision = await brain.evaluate(baseOpportunity, 5);

    expect(decision.action).toBe('COUNTER_OFFER');
    expect(decision.permissionGranted).toBe(false);
    expect(decision.breakdown.capacityAvailable).toBe(false);
    expect(decision.counterOfferPrice).toBeDefined();
    expect(decision.justification).toContain('Capacity saturated');
  });
});
