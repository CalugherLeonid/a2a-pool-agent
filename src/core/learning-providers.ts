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
    // R6: Scale historical average by task complexity (0.0 to 1.0, baseline 0.5)
    const clampedComplexity = Math.max(0, Math.min(1, complexity));
    const complexityMultiplier = 0.7 + 0.6 * clampedComplexity;
    const estimatedUsd = avg * complexityMultiplier;

    return {
      estimatedUsd,
      profile: {
        typicalUsd: estimatedUsd,
        worstCaseUsd: estimatedUsd * (clampedComplexity > 0.7 ? 2.2 : 1.8),
      },
      source: 'learning',
    };
  }
}
