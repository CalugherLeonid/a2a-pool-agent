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
  ReasoningTier,
  Usd,
} from './types/index.js';
import type { AdapterEconomics } from '../config/economics.js';
import type { CostEstimator } from './cost-estimator.js';
import type { ModelRouter } from './model-router.js';
import type { MetaToolRegistry } from './meta-tools/registry.js';
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
  | 'reject_below_min_time_adjusted'
  | 'reject_expired_deadline'
  | 'reject_unknown_tool'
  | 'reject_tool_not_whitelisted';

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
  metaToolRegistry?: MetaToolRegistry;
  toolWhitelist?: string[];
}

export class TriageEngine {
  constructor(private readonly deps: TriageDeps) {}

  async decide(input: TriageInput): Promise<EconomicDecision> {
    const { task, adapterId, capabilities } = input;
    const { limits } = capabilities;

    // --- SYSTEM 1 (Deterministic Fast Path & Instant Rule Enforcement) ---
    // 1. Budget minimum threshold check
    if (task.budgetEstimateUsd < limits.minBudgetUsd) {
      return this.reject(
        input,
        'reject_below_min_budget',
        'budget ' + task.budgetEstimateUsd + ' < min ' + limits.minBudgetUsd,
      );
    }

    // 2. Deadline validity check (instant sub-second check)
    if (task.deadlineS !== undefined && task.deadlineS <= 0) {
      return this.reject(
        input,
        'reject_expired_deadline',
        'deadline expired or invalid: ' + task.deadlineS,
      );
    }

    // 3. Tool whitelist check (if whitelist is configured)
    if (
      this.deps.toolWhitelist &&
      this.deps.toolWhitelist.length > 0 &&
      !this.deps.toolWhitelist.includes(task.type) &&
      !this.deps.metaToolRegistry?.getLatest(task.type)
    ) {
      return this.reject(
        input,
        'reject_tool_not_whitelisted',
        `task type ${task.type} is not permitted by tool whitelist`,
      );
    }

    // 4. Meta-tool identification for System 1 fast path
    const taskInput =
      task.input && typeof task.input === 'object'
        ? (task.input as Record<string, unknown>)
        : undefined;
    const taskRaw =
      task.raw && typeof task.raw === 'object'
        ? (task.raw as Record<string, unknown>)
        : undefined;

    const requestedToolId =
      task.type === 'meta_tool' && typeof taskInput?.toolId === 'string'
        ? taskInput.toolId
        : task.type === 'meta_tool' && typeof taskRaw?.toolId === 'string'
          ? (taskRaw.toolId as string)
          : undefined;

    if (task.type === 'meta_tool' && requestedToolId && this.deps.metaToolRegistry) {
      if (!this.deps.metaToolRegistry.getLatest(requestedToolId)) {
        return this.reject(
          input,
          'reject_unknown_tool',
          `requested meta-tool '${requestedToolId}' is not registered`,
        );
      }
    }

    // Determine reasoning tier: System 1 fast path vs System 2 deep escalation
    let tier: ReasoningTier = 'system2_deep';
    let matchedToolId: string | undefined;

    if (requestedToolId && this.deps.metaToolRegistry?.getLatest(requestedToolId)) {
      tier = 'system1_fast';
      matchedToolId = requestedToolId;
    } else if (this.deps.metaToolRegistry?.getLatest(task.type)) {
      tier = 'system1_fast';
      matchedToolId = task.type;
    }

    const estimatedTimeS = input.estimatedTimeS ?? (tier === 'system1_fast' ? 5 : 30);
    const confidenceHint = input.confidenceHint ?? (tier === 'system1_fast' ? 0.95 : 0.5);
    const estimatedGasCostUsd =
      input.estimatedGasCostUsd ?? this.deps.defaultGasCostUsd;

    // In System 1, deterministic execution in sandbox has negligible cost (no expensive LLM tokens)
    let expectedExecutionCostUsd: number;
    if (tier === 'system1_fast') {
      expectedExecutionCostUsd = 0.0001;
    } else {
      const costEstimate = await this.deps.costEstimator.estimate(
        task.type,
        adapterId,
        1 - confidenceHint,
      );
      expectedExecutionCostUsd = costEstimate.estimatedUsd;
    }

    const expectedRevenueUsd = task.budgetEstimateUsd;
    const platformFeePct = limits.platformFeePct;
    const platformFeeUsd = toNumber(mul(expectedRevenueUsd, platformFeePct));
    const expectedNetRevenueUsd = toNumber(
      sub(expectedRevenueUsd, platformFeeUsd),
    );
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

    const successProbability = tier === 'system1_fast'
      ? 0.98
      : await this.deps.successProb.get(task.type, adapterId);

    const thresholds = {
      minProfitUsd: this.deps.thresholds.minProfitUsd,
      minSuccessProbability: this.deps.thresholds.minSuccessProbability,
      minTimeAdjustedProfit: this.deps.thresholds.minTimeAdjustedProfit,
    };

    // --- Model from router (or deterministic for System 1) ---
    const model =
      input.model ??
      (tier === 'system1_fast'
        ? 'deterministic-tool'
        : await this.deps.modelRouter.select(task.type, adapterId));
    const strategyId = tier === 'system1_fast' ? 'system1_fast' : 'default';

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
        tier,
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
        tier,
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
        tier,
      );
    }

    log.debug(
      {
        adapterId,
        taskId: task.id,
        taskType: task.type,
        model,
        tier,
        matchedToolId,
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
      tier,
      matchedToolId,
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
      strategyId: 'system1_fast',
      model: input.model ?? 'unselected',
      reason,
      tier: 'system1_fast',
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
    tier: ReasoningTier = 'system2_deep',
  ): EconomicDecision {
    log.debug({ reason, detail, tier }, 'reject');
    return {
      decision: 'REJECT',
      confidence: 0,
      components,
      thresholds,
      successProbability,
      strategyId,
      model,
      reason,
      tier,
    };
  }
}
