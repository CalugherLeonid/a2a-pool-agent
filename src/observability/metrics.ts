/**
 * Aggregate metrics computed from the database.
 *
 * Toate query-urile sunt filtrate pe environment-ul agentului curent.
 * Astfel development si staging raman izolate.
 */

import { query } from '../persistence/pool.js';

export interface OverviewMetrics {
  windowDays: number;
  totalTasks: number;
  successTasks: number;
  successRate: number;
  rejectedTasks: number;
  rejectRate: number;
  totalRevenueUsd: number;
  totalCostUsd: number;
  totalProfitUsd: number;
  avgProfitPerTaskUsd: number;
  avgCostPerTaskUsd: number;
  avgLatencyS: number;
  ledgerBalanced: boolean;
}

export interface PerTaskTypeMetrics {
  taskType: string;
  tasks: number;
  successRate: number;
  avgCostUsd: number;
  avgProfitUsd: number;
  avgLatencyS: number;
  dominantModel: string;
  dominantProvider: string;
}

export interface PerProviderMetrics {
  provider: string;
  tasks: number;
  successRate: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgLatencyS: number;
}

export interface PerAdapterMetrics {
  adapterId: string;
  tasks: number;
  successRate: number;
  totalRevenueUsd: number;
  totalProfitUsd: number;
  avgTimeAdjustedProfit: number;
}

export interface Alert {
  severity: 'info' | 'warn' | 'critical';
  code: string;
  message: string;
  value?: number | string;
  threshold?: number | string;
}

export class Metrics {
  constructor(private readonly environment: string) {}

  async overview(windowDays = 1): Promise<OverviewMetrics> {
    const res = await query<{
      total_tasks: string;
      success_tasks: string;
      total_revenue: string;
      total_cost: string;
      total_profit: string;
      avg_latency: string;
    }>(
      `SELECT
         COUNT(*)::text                                AS total_tasks,
         SUM(CASE WHEN actual_success THEN 1 ELSE 0 END)::text AS success_tasks,
         COALESCE(SUM(revenue_usd), 0)::text           AS total_revenue,
         COALESCE(SUM(actual_cost_usd), 0)::text       AS total_cost,
         COALESCE(SUM(profit_usd), 0)::text            AS total_profit,
         COALESCE(AVG(actual_latency_s), 0)::text      AS avg_latency
       FROM learning_events
       WHERE environment = $1
         AND ts > now() - ($2 || ' days')::interval`,
      [this.environment, String(windowDays)],
    );

    const r = res.rows[0]!;
    const totalTasks = Number(r.total_tasks);
    const successTasks = Number(r.success_tasks);
    const totalRevenueUsd = Number(r.total_revenue);
    const totalCostUsd = Number(r.total_cost);
    const totalProfitUsd = Number(r.total_profit);

    const rejectedTasks = 0;

    const ledgerRes = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
       FROM (
         SELECT le.transaction_id
         FROM ledger_entries le
         JOIN transactions t ON t.id = le.transaction_id
         WHERE t.task_id IN (
           SELECT DISTINCT task_id
           FROM learning_events
           WHERE environment = $1
         )
         GROUP BY le.transaction_id
         HAVING ABS(SUM(le.debit) - SUM(le.credit)) > 0.00000001
       ) x`,
      [this.environment],
    );
    const ledgerBalanced = Number(ledgerRes.rows[0]?.n ?? 0) === 0;

    return {
      windowDays,
      totalTasks,
      successTasks,
      successRate: totalTasks > 0 ? successTasks / totalTasks : 0,
      rejectedTasks,
      rejectRate: totalTasks > 0 ? rejectedTasks / totalTasks : 0,
      totalRevenueUsd,
      totalCostUsd,
      totalProfitUsd,
      avgProfitPerTaskUsd: totalTasks > 0 ? totalProfitUsd / totalTasks : 0,
      avgCostPerTaskUsd: totalTasks > 0 ? totalCostUsd / totalTasks : 0,
      avgLatencyS: Number(r.avg_latency),
      ledgerBalanced,
    };
  }

  async perTaskType(windowDays = 7): Promise<PerTaskTypeMetrics[]> {
    const res = await query<{
      task_type: string;
      tasks: string;
      success_rate: string;
      avg_cost: string;
      avg_profit: string;
      avg_latency: string;
      dominant_model: string;
      dominant_provider: string;
    }>(
      `WITH agg AS (
         SELECT
           task_type,
           COUNT(*)::text                                AS tasks,
           AVG(actual_success::int)::text                AS success_rate,
           AVG(actual_cost_usd)::text                    AS avg_cost,
           AVG(profit_usd)::text                         AS avg_profit,
           AVG(actual_latency_s)::text                   AS avg_latency
         FROM learning_events
         WHERE environment = $1
           AND ts > now() - ($2 || ' days')::interval
         GROUP BY task_type
       ),
       dom AS (
         SELECT DISTINCT ON (task_type)
           task_type,
           actual_model    AS dominant_model,
           actual_provider AS dominant_provider
         FROM learning_events
         WHERE environment = $1
           AND ts > now() - ($2 || ' days')::interval
         GROUP BY task_type, actual_model, actual_provider
         ORDER BY task_type, COUNT(*) DESC
       )
       SELECT
         agg.task_type,
         agg.tasks,
         agg.success_rate,
         agg.avg_cost,
         agg.avg_profit,
         agg.avg_latency,
         dom.dominant_model,
         dom.dominant_provider
       FROM agg JOIN dom USING (task_type)
       ORDER BY agg.task_type`,
      [this.environment, String(windowDays)],
    );

    return res.rows.map((r) => ({
      taskType: r.task_type,
      tasks: Number(r.tasks),
      successRate: Number(r.success_rate),
      avgCostUsd: Number(r.avg_cost),
      avgProfitUsd: Number(r.avg_profit),
      avgLatencyS: Number(r.avg_latency),
      dominantModel: r.dominant_model,
      dominantProvider: r.dominant_provider,
    }));
  }

  async perProvider(windowDays = 7): Promise<PerProviderMetrics[]> {
    const res = await query<{
      provider: string;
      tasks: string;
      success_rate: string;
      total_cost: string;
      avg_cost: string;
      avg_latency: string;
    }>(
      `SELECT
         actual_provider                        AS provider,
         COUNT(*)::text                         AS tasks,
         AVG(actual_success::int)::text         AS success_rate,
         SUM(actual_cost_usd)::text             AS total_cost,
         AVG(actual_cost_usd)::text             AS avg_cost,
         AVG(actual_latency_s)::text            AS avg_latency
       FROM learning_events
       WHERE environment = $1
         AND ts > now() - ($2 || ' days')::interval
       GROUP BY actual_provider
       ORDER BY COUNT(*) DESC`,
      [this.environment, String(windowDays)],
    );

    return res.rows.map((r) => ({
      provider: r.provider,
      tasks: Number(r.tasks),
      successRate: Number(r.success_rate),
      totalCostUsd: Number(r.total_cost),
      avgCostUsd: Number(r.avg_cost),
      avgLatencyS: Number(r.avg_latency),
    }));
  }

  async perAdapter(windowDays = 7): Promise<PerAdapterMetrics[]> {
    const res = await query<{
      adapter_id: string;
      tasks: string;
      success_rate: string;
      total_revenue: string;
      total_profit: string;
      avg_tap: string;
    }>(
      `SELECT
         adapter_id                                AS adapter_id,
         COUNT(*)::text                            AS tasks,
         AVG(actual_success::int)::text            AS success_rate,
         SUM(revenue_usd)::text                    AS total_revenue,
         SUM(profit_usd)::text                     AS total_profit,
         AVG(time_adjusted_profit)::text           AS avg_tap
       FROM learning_events
       WHERE environment = $1
         AND ts > now() - ($2 || ' days')::interval
       GROUP BY adapter_id
       ORDER BY SUM(profit_usd) DESC`,
      [this.environment, String(windowDays)],
    );

    return res.rows.map((r) => ({
      adapterId: r.adapter_id,
      tasks: Number(r.tasks),
      successRate: Number(r.success_rate),
      totalRevenueUsd: Number(r.total_revenue),
      totalProfitUsd: Number(r.total_profit),
      avgTimeAdjustedProfit: Number(r.avg_tap),
    }));
  }

  async hourly(windowHours = 24): Promise<Array<{
    hour: string;
    tasks: number;
    profitUsd: number;
    costUsd: number;
  }>> {
    const res = await query<{
      hour: Date;
      tasks: string;
      profit_usd: string;
      cost_usd: string;
    }>(
      `SELECT
         date_trunc('hour', ts) AS hour,
         COUNT(*)::text         AS tasks,
         SUM(profit_usd)::text  AS profit_usd,
         SUM(actual_cost_usd)::text AS cost_usd
       FROM learning_events
       WHERE environment = $1
         AND ts > now() - ($2 || ' hours')::interval
       GROUP BY 1
       ORDER BY 1 DESC`,
      [this.environment, String(windowHours)],
    );

    return res.rows.map((r) => ({
      hour: r.hour.toISOString(),
      tasks: Number(r.tasks),
      profitUsd: Number(r.profit_usd),
      costUsd: Number(r.cost_usd),
    }));
  }

  async alerts(): Promise<Alert[]> {
    const alerts: Alert[] = [];
    const lastHour = await this.overview(1 / 24);
    const last24h = await this.overview(1);

    if (last24h.totalTasks >= 10 && last24h.successRate < 0.85) {
      alerts.push({
        severity: last24h.successRate < 0.7 ? 'critical' : 'warn',
        code: 'SUCCESS_RATE_LOW',
        message: 'Success rate below threshold',
        value: last24h.successRate,
        threshold: 0.85,
      });
    }

    if (!last24h.ledgerBalanced) {
      alerts.push({
        severity: 'critical',
        code: 'LEDGER_IMBALANCED',
        message: 'Ledger is not balanced — immediate investigation required',
      });
    }

    if (lastHour.totalTasks === 0) {
      alerts.push({
        severity: 'warn',
        code: 'NO_ACTIVITY',
        message: 'No tasks processed in the last hour',
      });
    }

    if (last24h.totalTasks >= 5 && last24h.totalProfitUsd < 0) {
      alerts.push({
        severity: 'critical',
        code: 'NEGATIVE_PROFIT',
        message: 'Cumulative profit is negative over 24h',
        value: last24h.totalProfitUsd,
        threshold: 0,
      });
    }

    if (last24h.avgCostPerTaskUsd > 0.10) {
      alerts.push({
        severity: 'warn',
        code: 'COST_PER_TASK_HIGH',
        message: 'Average cost per task is high',
        value: last24h.avgCostPerTaskUsd,
        threshold: 0.10,
      });
    }

    return alerts;
  }
}
