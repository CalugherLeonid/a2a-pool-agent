import type {
  Iso8601,
  LlmProvider,
  Probability,
  QualityScore,
  Usd,
  Uuid,
} from './primitives.js';

/** What triage predicted BEFORE execution. */
export interface PredictedValues {
  costUsd: Usd;
  latencyS: number;
  successProb: Probability;
  quality: QualityScore;
  model: string;
  settlementDelayH: number;
}

/** What actually happened AFTER execution. */
export interface ActualValues {
  costUsd: Usd;
  latencyS: number;
  success: boolean;
  quality: QualityScore;
  model: string;
  provider: LlmProvider;
  settlementDelayH: number;
  platformFeeUsd: Usd;
  gasCostUsd: Usd;
}

export type ClientFeedback = 'accepted' | 'rejected' | 'timeout' | 'disputed';

/**
 * The atomic unit of learning.
 *
 * Persisted to the `learning_events` table in Neon. Aggregated by
 * `memory/lessons.ts` to feed the model router, the economic triage,
 * and cross-platform arbitrage.
 */
export interface LearningEvent {
  id: Uuid;
  agentId: Uuid;
  taskId: string;
  adapterId: string;
  taskType: string;
  strategyId: string;

  predicted: PredictedValues;
  actual: ActualValues;

  budgetContext: {
    dailyUsed: Usd;
    dailyCap: Usd;
  };

  revenueUsd: Usd;
  profitUsd: Usd;
  timeAdjustedProfit: Usd;

  errorKind?: string;
  clientFeedback?: ClientFeedback;

  ts: Iso8601;
}