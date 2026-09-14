/**
 * Economic triage engine.
 *
 * ACCEPT iff:
 *   expected_profit > min_profit_usd
 *   AND success_probability > min_success_probability
 *   AND time_adjusted_profit > min_time_adjusted_profit
 *
 * delay_floor_hours guarantees a minimum settlement delay so that
 * time_adjusted_profit stays in a realistic band.
 */

import type {
  AdapterCapabilities,
  EconomicDecision,
  ProfitComponents,
  RawTask,
  Usd,
} from './types/index.js';
import type { AdapterEconomics } from '../config/economics.js';
import type { CostEstimator } from './cost-estimator.js';
import type { ModelRouter } from './model-router.js';
import { add, div, gt, mul, sub, toNumber } from './money.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('triage');

export interface SuccessProbabilityProvider {
  get(taskType: string, adapterId: string): Promise<number>;
}

export class PriorSuccessProbabilityProvider
  implements SuccessProbabilityProvider
{
  constructor(private readonly prior: number) {}
  async get(_taskType: string, _adapterId: string): Promise<number> {
    return this.prior;
  }
}

export type TriageReason =
  | 'accept'
  | 'reject_below_min_budget'
  | 'reject_below_min_profit'
  | 'reject_below_min_success_prob'
  | 'reject_below_min_time_adjusted';

export interface TriageInput {
  task: RawTask;
  adapterId: string;
  capabilities: AdapterCapabilities;
  confidenceHint?: number;
  estimatedTimeS?: number;
  model?: string;
  estimatedGasCostUsd?: Usd;
}

export interface TriageDeps {
  thresholds: AdapterEconomics;
  successProb: SuccessProbabilityProvider;
  modelRouter: ModelRouter;
  costEstimator: CostEstimator;
  defaultGasCostUsd: Usd;
  delayFloorHours: number;
}

export class TriageEngine {
  constructor(private readonly deps: TriageDeps) {}

  async decide(input: TriageInput): Promise<EconomicDecision> {
    const { task, adapterId, capabilities } = input;
    const { limits } = capabilities;

    if (task.budgetEstimateUsd < limits.minBudgetUsd) {
      return this.reject(
        input,
        'reject_below_min_budget',
        'budget ' + task.budgetEstimateUsd + ' < min ' + limits.minBudgetUsd,
      );
    }

    const estimatedTimeS = input.estimatedTimeS ?? 30;
    const confidenceHint = input.confidenceHint ?? 0.5;
    const estimatedGasCostUsd =
      input.estimatedGasCostUsd ?? this.deps.defaultGasCostUsd;

    const costEstimate = await this.deps.costEstimator.estimate(
      task.type,
      adapterId,
      1 - confidenceHint,
    );

    const expectedRevenueUsd = task.budgetEstimateUsd;
    const platformFeePct = limits.platformFeePct;
    const platformFeeUsd = toNumber(mul(expectedRevenueUsd, platformFeePct));
    const expectedNetRevenueUsd = toNumber(
      sub(expectedRevenueUsd, platformFeeUsd),
    );
    const expectedExecutionCostUsd = costEstimate.estimatedUsd;
    const expectedTotalCostUsd = toNumber(
      add(expectedExecutionCostUsd, estimatedGasCostUsd),
    );
    const expectedProfitUsd = toNumber(
      sub(expectedNetRevenueUsd, expectedTotalCostUsd),
    );

    // --- Delay floor: eliminate unrealistic TAP when settlement is
    // instant (e.g. mock adapter) ---
    const adapterDelayH = limits.averageSettlementDelayHours;
    const effectiveDelayH = Math.max(adapterDelayH, this.deps.delayFloorHours);
    const expectedTotalTimeH = toNumber(
      add(div(estimatedTimeS, 3600), effectiveDelayH),
    );
    const timeAdjustedProfit = toNumber(
      div(expectedProfitUsd, Math.max(expectedTotalTimeH, 1e-6)),
    );

    const components: ProfitComponents = {
      expectedRevenueUsd,
      platformFeePct,
      platformFeeUsd,
      expectedNetRevenueUsd,
      expectedExecutionCostUsd,
      expectedGasCostUsd: estimatedGasCostUsd,
      expectedTotalCostUsd,
      expectedProfitUsd,
      expectedSettlementDelayH: effectiveDelayH,
      expectedTotalTimeH,
      timeAdjustedProfit,
    };

    const successProbability = await this.deps.successProb.get(
      task.type,
      adapterId,
    );

    const thresholds = {
      minProfitUsd: this.deps.thresholds.minProfitUsd,
      minSuccessProbability: this.deps.thresholds.minSuccessProbability,
      minTimeAdjustedProfit: this.deps.thresholds.minTimeAdjustedProfit,
    };

    // --- Model from router (unless explicitly provided) ---
    const model =
      input.model ?? (await this.deps.modelRouter.select(task.type, adapterId));
    const strategyId = 'default';

    if (!gt(expectedProfitUsd, thresholds.minProfitUsd)) {
      return this.rejectWith(
        'reject_below_min_profit',
        'expected_profit ' +
          expectedProfitUsd.toFixed(4) +
          ' <= min ' +
          thresholds.minProfitUsd,
        components,
        thresholds,
        successProbability,
        model,
        strategyId,
      );
    }

    if (successProbability <= thresholds.minSuccessProbability) {
      return this.rejectWith(
        'reject_below_min_success_prob',
        'success_prob ' +
          successProbability.toFixed(3) +
          ' <= min ' +
          thresholds.minSuccessProbability,
        components,
        thresholds,
        successProbability,
        model,
        strategyId,
      );
    }

    if (!gt(timeAdjustedProfit, thresholds.minTimeAdjustedProfit)) {
      return this.rejectWith(
        'reject_below_min_time_adjusted',
        'time_adjusted_profit ' +
          timeAdjustedProfit.toFixed(4) +
          ' <= min ' +
          thresholds.minTimeAdjustedProfit,
        components,
        thresholds,
        successProbability,
        model,
        strategyId,
      );
    }

    log.debug(
      {
        adapterId,
        taskId: task.id,
        taskType: task.type,
        model,
        costSource: costEstimate.source,
        expectedProfitUsd,
        timeAdjustedProfit,
        successProbability,
      },
      'accept',
    );

    return {
      decision: 'ACCEPT',
      confidence: successProbability,
      components,
      thresholds,
      successProbability,
      strategyId,
      model,
      reason: 'accept',
    };
  }

  private reject(
    input: TriageInput,
    reason: TriageReason,
    detail: string,
  ): EconomicDecision {
    const zero: ProfitComponents = {
      expectedRevenueUsd: input.task.budgetEstimateUsd,
      platformFeePct: input.capabilities.limits.platformFeePct,
      platformFeeUsd: 0,
      expectedNetRevenueUsd: 0,
      expectedExecutionCostUsd: 0,
      expectedGasCostUsd: 0,
      expectedTotalCostUsd: 0,
      expectedProfitUsd: 0,
      expectedSettlementDelayH:
        input.capabilities.limits.averageSettlementDelayHours,
      expectedTotalTimeH: 0,
      timeAdjustedProfit: 0,
    };

    log.debug(
      { adapterId: input.adapterId, taskId: input.task.id, reason, detail },
      'reject',
    );

    return {
      decision: 'REJECT',
      confidence: 0,
      components: zero,
      thresholds: {
        minProfitUsd: this.deps.thresholds.minProfitUsd,
        minSuccessProbability: this.deps.thresholds.minSuccessProbability,
        minTimeAdjustedProfit: this.deps.thresholds.minTimeAdjustedProfit,
      },
      successProbability: 0,
      strategyId: 'default',
      model: input.model ?? 'unselected',
      reason,
    };
  }

  private rejectWith(
    reason: TriageReason,
    detail: string,
    components: ProfitComponents,
    thresholds: EconomicDecision['thresholds'],
    successProbability: number,
    model: string,
    strategyId: string,
  ): EconomicDecision {
    log.debug({ reason, detail }, 'reject');
    return {
      decision: 'REJECT',
      confidence: 0,
      components,
      thresholds,
      successProbability,
      strategyId,
      model,
      reason,
    };
  }
}
