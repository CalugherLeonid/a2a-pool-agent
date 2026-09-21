/**
 * Execution cost estimator.
 *
 * Provides an estimate of the LLM execution cost for a given task
 * BEFORE it is executed. Used by the economic triage to compute
 * expected profit.
 *
 * Two implementations:
 *   - StaticCostEstimator:   hardcoded per task type
 *   - LearningCostEstimator: reads from learning_events via LearningStore
 */

import type { Usd } from './types/index.js';
import type { LearningStore } from './learning.js';

export interface CostProfile {
  typicalUsd: Usd;
  worstCaseUsd: Usd;
}

const PROFILES: Record<string, CostProfile> = {
  extract: { typicalUsd: 0.05, worstCaseUsd: 0.10 },
  summarize: { typicalUsd: 0.08, worstCaseUsd: 0.15 },
  classify: { typicalUsd: 0.02, worstCaseUsd: 0.05 },
  transform: { typicalUsd: 0.04, worstCaseUsd: 0.09 },
};

const DEFAULT_PROFILE: CostProfile = {
  typicalUsd: 0.06,
  worstCaseUsd: 0.12,
};

export interface CostEstimate {
  estimatedUsd: Usd;
  profile: CostProfile;
  source: 'static-table' | 'learning';
}

export interface CostEstimator {
  estimate(
    taskType: string,
    adapterId: string,
    complexity: number,
  ): Promise<CostEstimate>;
}

/** Pure static function retained for backwards compatibility. */
export function estimateExecutionCost(
  taskType: string,
  complexity = 0.5,
): CostEstimate {
  const profile = PROFILES[taskType] ?? DEFAULT_PROFILE;
  const estimatedUsd =
    complexity > 0.7 ? profile.worstCaseUsd : profile.typicalUsd;
  return { estimatedUsd, profile, source: 'static-table' };
}

export class StaticCostEstimator implements CostEstimator {
  async estimate(
    taskType: string,
    _adapterId: string,
    complexity: number,
  ): Promise<CostEstimate> {
    return estimateExecutionCost(taskType, complexity);
  }
}

export class LearningCostEstimator implements CostEstimator {
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

    // Use observed average; worst-case is 2x for safety margin.
    const avg = stats.avgCost;
    return {
      estimatedUsd: avg,
      profile: { typicalUsd: avg, worstCaseUsd: avg * 2 },
      source: 'learning',
    };
  }
}

/**
 * Calculates execution cost in USD based on actual token usage and model/provider.
 */
export function calculateTokenCostUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
  provider?: string,
): number {
  const m = (model ?? '').toLowerCase();
  const p = (provider ?? '').toLowerCase();

  let rates = { in: 0.15, out: 0.60 }; // default conservative rates

  if (p === 'google' || p === 'gemini' || m.startsWith('gemini')) {
    if (m.includes('pro')) {
      rates = { in: 1.25, out: 5.00 };
    } else {
      rates = { in: 0.075, out: 0.30 };
    }
  } else if (p === 'groq' || m.includes('groq')) {
    if (m.includes('8b')) {
      rates = { in: 0.05, out: 0.08 };
    } else {
      rates = { in: 0.59, out: 0.79 };
    }
  } else if (p === 'openrouter' || m.includes('openrouter')) {
    if (m.includes(':free') || m.includes('/free')) {
      rates = { in: 0, out: 0 };
    } else if (m.includes('deepseek')) {
      rates = { in: 0.14, out: 0.28 };
    } else if (m.includes('gemini')) {
      rates = { in: 0.075, out: 0.30 };
    } else if (m.includes('llama')) {
      rates = { in: 0.35, out: 0.40 };
    } else {
      rates = { in: 0.50, out: 1.50 };
    }
  } else if (m.includes('deepseek')) {
    rates = { in: 0.14, out: 0.28 };
  } else if (m.includes('claude') || p === 'anthropic') {
    rates = { in: 3.0, out: 15.0 };
  }

  const cost = (tokensIn / 1_000_000) * rates.in + (tokensOut / 1_000_000) * rates.out;
  return Number(cost.toFixed(6));
}
