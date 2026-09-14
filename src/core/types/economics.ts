import type { Probability, Usd } from './primitives.js';

export type TriageDecision = 'ACCEPT' | 'REJECT' | 'NEGOTIATE';

/**
 * Every intermediate value used in the economic triage formula.
 * Persisted in audit logs alongside the decision.
 */
export interface ProfitComponents {
  expectedRevenueUsd: Usd;
  platformFeePct: number;
  platformFeeUsd: Usd;
  expectedNetRevenueUsd: Usd;
  expectedExecutionCostUsd: Usd;
  expectedGasCostUsd: Usd;
  expectedTotalCostUsd: Usd;
  expectedProfitUsd: Usd;
  expectedSettlementDelayH: number;
  expectedTotalTimeH: number;
  timeAdjustedProfit: Usd;
}

export interface EconomicDecision {
  decision: TriageDecision;
  confidence: Probability;
  components: ProfitComponents;
  /** Threshold values used to make the decision (for audit). */
  thresholds: {
    minProfitUsd: Usd;
    minSuccessProbability: Probability;
    minTimeAdjustedProfit: Usd;
  };
  successProbability: Probability;
  strategyId: string;
  model: string;
  reason: string;
}