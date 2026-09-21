import { describe, it, expect } from 'vitest';
import { TriageEngine, PriorSuccessProbabilityProvider } from './triage.js';
import { StaticCostEstimator } from './cost-estimator.js';
import { FixedModelRouter } from './model-router.js';
import type { AdapterCapabilities, RawTask } from './types/index.js';

describe('TriageEngine', () => {
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

  const deps = {
    thresholds,
    successProb: new PriorSuccessProbabilityProvider(0.95),
    modelRouter: new FixedModelRouter('gemini-2.5-flash'),
    costEstimator: new StaticCostEstimator(),
    defaultGasCostUsd: 0.001,
    delayFloorHours: 0.5,
  };

  const engine = new TriageEngine(deps);

  it('rejects tasks below min budget', async () => {
    const task: RawTask = {
      id: 'task-low-budget',
      source: 'mock',
      type: 'extract',
      budgetEstimateUsd: 0.01, // below min 0.05
      deadlineS: 60,
      prompt: 'test',
      outputSchema: { type: 'object' },
      raw: {},
      observedAt: new Date().toISOString(),
    };

    const decision = await engine.decide({
      task,
      adapterId: 'mock',
      capabilities: defaultCaps,
    });

    expect(decision.decision).toBe('REJECT');
    expect(decision.reason).toContain('reject_below_min_budget');
  });

  it('accepts profitable tasks meeting success probability and time-adjusted profit', async () => {
    const task: RawTask = {
      id: 'task-profitable',
      source: 'mock',
      type: 'extract',
      budgetEstimateUsd: 1.0, // generous reward
      deadlineS: 60,
      prompt: 'extract data',
      outputSchema: { type: 'object' },
      raw: {},
      observedAt: new Date().toISOString(),
    };

    const decision = await engine.decide({
      task,
      adapterId: 'mock',
      capabilities: defaultCaps,
    });

    expect(decision.decision).toBe('ACCEPT');
    expect(decision.reason).toBe('accept');
    expect(decision.model).toBe('gemini-2.5-flash');
    expect(decision.components.expectedProfitUsd).toBeGreaterThan(0.5);
  });

  it('rejects tasks when success probability is below threshold', async () => {
    const lowProbEngine = new TriageEngine({
      ...deps,
      successProb: new PriorSuccessProbabilityProvider(0.5), // < 0.8 min
    });

    const task: RawTask = {
      id: 'task-low-prob',
      source: 'mock',
      type: 'extract',
      budgetEstimateUsd: 1.0,
      deadlineS: 60,
      prompt: 'test',
      outputSchema: { type: 'object' },
      raw: {},
      observedAt: new Date().toISOString(),
    };

    const decision = await lowProbEngine.decide({
      task,
      adapterId: 'mock',
      capabilities: defaultCaps,
    });

    expect(decision.decision).toBe('REJECT');
    expect(decision.reason).toContain('reject_below_min_success_prob');
  });
});
