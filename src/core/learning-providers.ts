/**
 * Learning-backed providers for triage.
 *
 * These read real statistics from learning_events and fall back to
 * prior/static values when there is insufficient data.
 */

import type { SuccessProbabilityProvider } from './triage.js';
import type { CostEstimator, CostEstimate } from './cost-estimator.js';
import type { LearningStore } from './learning.js';
import { estimateExecutionCost } from './cost-estimator.js';

export class LearningBackedSuccessProbabilityProvider
  implements SuccessProbabilityProvider
{
  constructor(
    private readonly store: LearningStore,
    private readonly prior: number,
    private readonly windowDays: number,
    private readonly minSamples: number,
  ) {}

  async get(taskType: string, adapterId: string): Promise<number> {
    const stats = await this.store.successProbability(
      taskType,
      adapterId,
      this.windowDays,
      this.minSamples,
    );
    return stats?.successRate ?? this.prior;
  }
}

export class LearningBackedCostEstimator implements CostEstimator {
  constructor(
    private readonly store: LearningStore,
    private readonly windowDays: number,
    private readonly minSamples: number,
  ) {}

  async estimate(
    taskType: string,
    adapterId: string,
    complexity: number,
  ): Promise<CostEstimate> {
    const stats = await this.store.costEstimate(
      taskType,
      adapterId,
      this.windowDays,
      this.minSamples,
    );

    if (stats === null) {
      return estimateExecutionCost(taskType, complexity);
    }

    const avg = stats.avgCost;
    return {
      estimatedUsd: avg,
      profile: { typicalUsd: avg, worstCaseUsd: avg * 2 },
      source: 'learning',
    };
  }
}
