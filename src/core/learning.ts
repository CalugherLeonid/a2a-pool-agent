/**
 * Learning store.
 *
 * Every row is tagged with the agent's current environment. Queries
 * filter by it, so simulation data never contaminates production
 * learning and vice versa.
 */

import { query } from '../persistence/pool.js';
import type { LearningEvent } from './types/index.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('learning');

export interface ModelStats {
  model: string;
  provider: string;
  avgCost: number;
  avgQuality: number;
  successRate: number;
  avgLatency: number;
  n: number;
}

export interface AdapterStats {
  adapterId: string;
  avgProfit: number;
  avgTimeAdjustedProfit: number;
  n: number;
}

export interface SuccessStats {
  successRate: number;
  n: number;
}

export interface CostStats {
  avgCost: number;
  n: number;
}

export interface CalibrationStats {
  taskType: string;
  costBias: number;
  qualityBias: number;
  latencyBias: number;
  n: number;
}

export class LearningStore {
  constructor(private readonly environment: string) {}

  async record(event: LearningEvent): Promise<void> {
    await query(
      `INSERT INTO learning_events (
        environment,
        agent_id, task_id, adapter_id, task_type, strategy_id,
        predicted_cost_usd, predicted_latency_s, predicted_success_prob,
        predicted_quality, predicted_model, predicted_settlement_delay_h,
        actual_cost_usd, actual_latency_s, actual_success, actual_quality,
        actual_model, actual_provider, actual_settlement_delay_h,
        actual_platform_fee_usd, actual_gas_cost_usd,
        budget_daily_used, budget_daily_cap,
        revenue_usd, profit_usd, time_adjusted_profit,
        error_kind, client_feedback
      ) VALUES (
        $1,
        $2,$3,$4,$5,$6,
        $7,$8,$9,$10,$11,$12,
        $13,$14,$15,$16,$17,$18,$19,$20,$21,
        $22,$23,$24,$25,$26,
        $27,$28
      )`,
      [
        this.environment,
        event.agentId, event.taskId, event.adapterId, event.taskType,
        event.strategyId,
        event.predicted.costUsd.toFixed(8),
        event.predicted.latencyS.toFixed(2),
        event.predicted.successProb.toFixed(4),
        event.predicted.quality.toFixed(4),
        event.predicted.model,
        event.predicted.settlementDelayH.toFixed(2),
        event.actual.costUsd.toFixed(8),
        event.actual.latencyS.toFixed(2),
        event.actual.success,
        event.actual.quality.toFixed(4),
        event.actual.model,
        event.actual.provider,
        event.actual.settlementDelayH.toFixed(2),
        event.actual.platformFeeUsd.toFixed(8),
        event.actual.gasCostUsd.toFixed(8),
        event.budgetContext.dailyUsed.toFixed(8),
        event.budgetContext.dailyCap.toFixed(8),
        event.revenueUsd.toFixed(8),
        event.profitUsd.toFixed(8),
        event.timeAdjustedProfit.toFixed(8),
        event.errorKind ?? null,
        event.clientFeedback ?? null,
      ],
    );

    log.info(
      {
        environment: this.environment,
        taskId: event.taskId,
        taskType: event.taskType,
        adapterId: event.adapterId,
        model: event.actual.model,
        provider: event.actual.provider,
        success: event.actual.success,
        profitUsd: event.profitUsd,
        timeAdjustedProfit: event.timeAdjustedProfit,
      },
      'learning event recorded',
    );
  }

  /** Sum of actual execution cost recorded today (UTC). Used by
   *  BudgetGuard to hydrate its state at startup. */
  async costToday(): Promise<number> {
    const res = await query<{ sum: string }>(
      `SELECT COALESCE(SUM(actual_cost_usd), 0)::text AS sum
       FROM learning_events
       WHERE environment = $1
         AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
      [this.environment],
    );
    return Number(res.rows[0]?.sum ?? 0);
  }

  async bestModel(
    taskType: string,
    adapterId: string,
    windowDays = 7,
    minSamples = 10,
  ): Promise<ModelStats[]> {
    const res = await query<{
      model: string;
      provider: string;
      avg_cost: string;
      avg_quality: string;
      success_rate: string;
      avg_latency: string;
      n: string;
    }>(
      `SELECT
         actual_model         AS model,
         actual_provider      AS provider,
         AVG(actual_cost_usd)::text        AS avg_cost,
         AVG(actual_quality)::text         AS avg_quality,
         AVG(actual_success::int)::text    AS success_rate,
         AVG(actual_latency_s)::text       AS avg_latency,
         COUNT(*)::text                    AS n
       FROM learning_events
       WHERE environment = $1
         AND task_type = $2
         AND adapter_id = $3
         AND ts > now() - ($4 || ' days')::interval
       GROUP BY actual_model, actual_provider
       HAVING COUNT(*) >= $5
       ORDER BY AVG(actual_success::int) DESC, AVG(actual_quality) DESC, AVG(actual_cost_usd) ASC, AVG(actual_latency_s) ASC`,
      [this.environment, taskType, adapterId, String(windowDays), minSamples],
    );

    return res.rows.map((r) => ({
      model: r.model,
      provider: r.provider,
      avgCost: Number(r.avg_cost),
      avgQuality: Number(r.avg_quality),
      successRate: Number(r.success_rate),
      avgLatency: Number(r.avg_latency),
      n: Number(r.n),
    }));
  }

  async bestAdapter(
    taskType: string,
    windowDays = 7,
    minSamples = 5,
  ): Promise<AdapterStats[]> {
    const res = await query<{
      adapter_id: string;
      avg_profit: string;
      avg_tap: string;
      n: string;
    }>(
      `SELECT
         adapter_id                       AS adapter_id,
         AVG(profit_usd)::text            AS avg_profit,
         AVG(time_adjusted_profit)::text  AS avg_tap,
         COUNT(*)::text                   AS n
       FROM learning_events
       WHERE environment = $1
         AND task_type = $2
         AND ts > now() - ($3 || ' days')::interval
       GROUP BY adapter_id
       HAVING COUNT(*) >= $4
       ORDER BY AVG(time_adjusted_profit) DESC`,
      [this.environment, taskType, String(windowDays), minSamples],
    );

    return res.rows.map((r) => ({
      adapterId: r.adapter_id,
      avgProfit: Number(r.avg_profit),
      avgTimeAdjustedProfit: Number(r.avg_tap),
      n: Number(r.n),
    }));
  }

  async successProbability(
    taskType: string,
    adapterId: string,
    windowDays = 7,
    minSamples = 10,
  ): Promise<SuccessStats | null> {
    const res = await query<{ success_rate: string; n: string }>(
      `SELECT
         AVG(actual_success::int)::text AS success_rate,
         COUNT(*)::text                 AS n
       FROM learning_events
       WHERE environment = $1
         AND task_type = $2
         AND adapter_id = $3
         AND ts > now() - ($4 || ' days')::interval
       HAVING COUNT(*) >= $5`,
      [this.environment, taskType, adapterId, String(windowDays), minSamples],
    );

    if (res.rows.length === 0) return null;
    const r = res.rows[0]!;
    return {
      successRate: Number(r.success_rate),
      n: Number(r.n),
    };
  }

  async costEstimate(
    taskType: string,
    adapterId: string,
    windowDays = 7,
    minSamples = 10,
  ): Promise<CostStats | null> {
    const res = await query<{ avg_cost: string; n: string }>(
      `SELECT
         AVG(actual_cost_usd)::text AS avg_cost,
         COUNT(*)::text             AS n
       FROM learning_events
       WHERE environment = $1
         AND task_type = $2
         AND adapter_id = $3
         AND ts > now() - ($4 || ' days')::interval
       HAVING COUNT(*) >= $5`,
      [this.environment, taskType, adapterId, String(windowDays), minSamples],
    );

    if (res.rows.length === 0) return null;
    const r = res.rows[0]!;
    return {
      avgCost: Number(r.avg_cost),
      n: Number(r.n),
    };
  }

  async calibration(
    windowDays = 7,
    minSamples = 10,
  ): Promise<CalibrationStats[]> {
    const res = await query<{
      task_type: string;
      cost_bias: string;
      quality_bias: string;
      latency_bias: string;
      n: string;
    }>(
      `SELECT
         task_type                                          AS task_type,
         AVG(predicted_cost_usd - actual_cost_usd)::text    AS cost_bias,
         AVG(predicted_quality - actual_quality)::text      AS quality_bias,
         AVG(predicted_latency_s - actual_latency_s)::text  AS latency_bias,
         COUNT(*)::text                                     AS n
       FROM learning_events
       WHERE environment = $1
         AND ts > now() - ($2 || ' days')::interval
       GROUP BY task_type
       HAVING COUNT(*) >= $3`,
      [this.environment, String(windowDays), minSamples],
    );

    return res.rows.map((r) => ({
      taskType: r.task_type,
      costBias: Number(r.cost_bias),
      qualityBias: Number(r.quality_bias),
      latencyBias: Number(r.latency_bias),
      n: Number(r.n),
    }));
  }

  async count(): Promise<number> {
    const res = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM learning_events WHERE environment = $1`,
      [this.environment],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async recentEvents(limit = 20): Promise<Array<{
    id: string;
    task_id: string;
    task_type: string;
    actual_model: string;
    actual_cost_usd: number;
    profit_usd: number;
    actual_success: boolean;
    ts: Date | string;
  }>> {
    const res = await query<{
      id: string;
      task_id: string;
      task_type: string;
      actual_model: string;
      actual_cost_usd: string;
      profit_usd: string;
      actual_success: boolean;
      ts: string;
    }>(
      `SELECT id, task_id, task_type, actual_model, actual_cost_usd::text, profit_usd::text, actual_success, ts
       FROM learning_events
       WHERE environment = $1
       ORDER BY ts DESC
       LIMIT $2`,
      [this.environment, limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      task_id: r.task_id,
      task_type: r.task_type,
      actual_model: r.actual_model,
      actual_cost_usd: Number(r.actual_cost_usd),
      profit_usd: Number(r.profit_usd),
      actual_success: Boolean(r.actual_success),
      ts: r.ts,
    }));
  }
}
