import { createLogger } from '../observability/logger.js';
import type { AggregatedMetrics, ExecutionTelemetry } from './types.js';

export * from './types.js';

const telemetryLog = createLogger('telemetry');

export interface AgentTelemetryMetrics {
  totalTasks: number;
  acceptedTasks: number;
  rejectedTasks: number;
  totalProfitAC: number;
  llmLatencyMs: number;
}

export class TelemetryCollector {
  private metrics: AgentTelemetryMetrics = {
    totalTasks: 0,
    acceptedTasks: 0,
    rejectedTasks: 0,
    totalProfitAC: 0,
    llmLatencyMs: 0,
  };

  private aggregated = {
    system1Count: 0,
    system2Count: 0,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    a2aTotalCount: 0,
    a2aSuccessCount: 0,
    ratchetAcceptedCount: 0,
    ratchetRejectedCount: 0,
    evolutionAttemptedCount: 0,
    evolutionAcceptedCount: 0,
    evolutionRejectedCount: 0,
    escrowLockedCount: 0,
    escrowReleasedCount: 0,
    escrowRefundedCount: 0,
    totalEscrowLockedUsd: 0,
    totalEscrowReleasedUsd: 0,
    totalEscrowRefundedUsd: 0,
    successCount: 0,
    failureCount: 0,
    fallbackCount: 0,
    providerCounts: new Map<string, number>(),
    a2aTransportCounts: new Map<string, number>(),
    a2aPeerCounts: new Map<string, number>(),
  };

  private executionHistory: ExecutionTelemetry[] = [];

  public recordTask(accepted: boolean): void {
    this.metrics.totalTasks++;
    if (accepted) {
      this.metrics.acceptedTasks++;
    } else {
      this.metrics.rejectedTasks++;
    }
  }

  public recordProfit(amount: number): void {
    this.metrics.totalProfitAC += amount;
  }

  public recordLatency(ms: number): void {
    this.metrics.llmLatencyMs = ms;
  }

  /**
   * Records execution telemetry across System 1 and System 2 paths.
   * Emits structured JSON log for observability.
   */
  public recordExecution(telemetry: ExecutionTelemetry, success = true): void {
    if (telemetry.systemPath === 'system1') {
      this.aggregated.system1Count++;
    } else {
      this.aggregated.system2Count++;
    }

    if (success) {
      this.aggregated.successCount++;
    } else {
      this.aggregated.failureCount++;
    }

    if (telemetry.fallbackUsed) {
      this.aggregated.fallbackCount++;
    }

    if (telemetry.provider) {
      const curr = this.aggregated.providerCounts.get(telemetry.provider) || 0;
      this.aggregated.providerCounts.set(telemetry.provider, curr + 1);
    }

    if (telemetry.transport) {
      const curr = this.aggregated.a2aTransportCounts.get(telemetry.transport) || 0;
      this.aggregated.a2aTransportCounts.set(telemetry.transport, curr + 1);
    }

    if (telemetry.peerId) {
      const curr = this.aggregated.a2aPeerCounts.get(telemetry.peerId) || 0;
      this.aggregated.a2aPeerCounts.set(telemetry.peerId, curr + 1);
    }

    this.aggregated.totalCostUsd += telemetry.costUsd || 0;
    this.aggregated.totalLatencyMs += telemetry.latencyMs || 0;
    this.aggregated.totalTokensIn += telemetry.tokensIn || 0;
    this.aggregated.totalTokensOut += telemetry.tokensOut || 0;
    this.metrics.llmLatencyMs = telemetry.latencyMs;

    this.executionHistory.push(telemetry);
    if (this.executionHistory.length > 500) {
      this.executionHistory.shift();
    }

    // Structured JSON logging for telemetry & alerting
    telemetryLog.info(
      {
        telemetry: {
          provider: telemetry.provider,
          model: telemetry.model,
          latencyMs: telemetry.latencyMs,
          tokensIn: telemetry.tokensIn,
          tokensOut: telemetry.tokensOut,
          costUsd: telemetry.costUsd,
          fallbackUsed: telemetry.fallbackUsed,
          fallbackChain: telemetry.fallbackChain,
          systemPath: telemetry.systemPath,
          timestamp: telemetry.timestamp,
          peerId: telemetry.peerId,
          transport: telemetry.transport,
        },
        success,
      },
      'execution_telemetry',
    );
  }

  /**
   * Records A2A delegation outcomes for computing a2aSuccessRate.
   */
  public recordA2ATask(success: boolean, telemetry?: ExecutionTelemetry): void {
    this.aggregated.a2aTotalCount++;
    if (success) {
      this.aggregated.a2aSuccessCount++;
    }
    if (telemetry) {
      this.recordExecution(telemetry, success);
    }
  }

  /**
   * Records a Ratchet acceptance or rejection decision.
   */
  public recordRatchetDecision(
    decision: 'accepted' | 'rejected' | 'rolled_back',
    details: Record<string, unknown> = {},
  ): void {
    if (decision === 'accepted') {
      this.aggregated.ratchetAcceptedCount++;
    } else {
      this.aggregated.ratchetRejectedCount++;
    }

    telemetryLog.info(
      {
        event: 'ratchet_decision',
        decision,
        ...details,
      },
      `ratchet_decision: ${decision}`,
    );
  }

  /**
   * Records a Morphling evolution attempt and outcome.
   */
  public recordEvolution(
    outcome: 'attempted' | 'accepted' | 'rejected',
    details: Record<string, unknown> = {},
  ): void {
    if (outcome === 'attempted') {
      this.aggregated.evolutionAttemptedCount++;
    } else if (outcome === 'accepted') {
      this.aggregated.evolutionAcceptedCount++;
    } else {
      this.aggregated.evolutionRejectedCount++;
    }

    telemetryLog.info(
      {
        event: `evolution_${outcome}`,
        outcome,
        ...details,
      },
      `morphling_evolution: ${outcome}`,
    );
  }

  /**
   * Records an Escrow event (locked, released, refunded).
   */
  public recordEscrowEvent(
    event: 'locked' | 'released' | 'refunded',
    details: {
      taskId: string;
      escrowId?: string;
      amountUsd?: number;
      from?: string;
      to?: string;
      reason?: string;
      [key: string]: unknown;
    },
  ): void {
    const amount = details.amountUsd ?? 0;
    if (event === 'locked') {
      this.aggregated.escrowLockedCount++;
      this.aggregated.totalEscrowLockedUsd += amount;
    } else if (event === 'released') {
      this.aggregated.escrowReleasedCount++;
      this.aggregated.totalEscrowReleasedUsd += amount;
    } else if (event === 'refunded') {
      this.aggregated.escrowRefundedCount++;
      this.aggregated.totalEscrowRefundedUsd += amount;
    }

    telemetryLog.info(
      {
        event: `escrow_${event}`,
        escrowEvent: event,
        ...details,
      },
      `escrow_${event}: task ${details.taskId} ($${amount})`,
    );
  }

  /**
   * Records real on-chain incoming payment received event.
   */
  public recordPaymentReceived(details: {
    txHash: string;
    amount: number;
    amountUsd: number;
    asset: string;
    from: string;
    to: string;
    network: string;
    [key: string]: unknown;
  }): void {
    telemetryLog.info(
      {
        event: 'payment_received',
        ...details,
      },
      `payment_received: ${details.amount} ${details.asset} ($${details.amountUsd}) on ${details.network} from ${details.from}`,
    );
  }

  /**
   * Computes real-time aggregated metrics.
   */
  public getAggregatedMetrics(): AggregatedMetrics {
    const totalExecutions = this.aggregated.system1Count + this.aggregated.system2Count;
    const system1HitRate = totalExecutions > 0 ? this.aggregated.system1Count / totalExecutions : 0;
    const averageCostUsd = totalExecutions > 0 ? this.aggregated.totalCostUsd / totalExecutions : 0;
    const averageLatencyMs = totalExecutions > 0 ? this.aggregated.totalLatencyMs / totalExecutions : 0;
    const a2aSuccessRate =
      this.aggregated.a2aTotalCount > 0
        ? this.aggregated.a2aSuccessCount / this.aggregated.a2aTotalCount
        : 0;
    const totalTokensConsumed = this.aggregated.totalTokensIn + this.aggregated.totalTokensOut;

    return {
      system1HitRate,
      averageCostUsd,
      averageLatencyMs,
      a2aSuccessRate,
      totalTokensConsumed,
      totalExecutions,
      system1Count: this.aggregated.system1Count,
      system2Count: this.aggregated.system2Count,
      a2aTotalCount: this.aggregated.a2aTotalCount,
      a2aSuccessCount: this.aggregated.a2aSuccessCount,
      ratchetAcceptedCount: this.aggregated.ratchetAcceptedCount,
      ratchetRejectedCount: this.aggregated.ratchetRejectedCount,
      evolutionAttemptedCount: this.aggregated.evolutionAttemptedCount,
      evolutionAcceptedCount: this.aggregated.evolutionAcceptedCount,
      evolutionRejectedCount: this.aggregated.evolutionRejectedCount,
    };
  }

  /**
   * Returns comprehensive metrics summary for observability dashboards and test assertions.
   */
  public getMetrics() {
    const agg = this.getAggregatedMetrics();
    const providerBreakdown: Record<string, number> = {};
    for (const [k, v] of this.aggregated.providerCounts.entries()) {
      providerBreakdown[k] = v;
    }
    const a2aTransportBreakdown: Record<string, number> = {};
    for (const [k, v] of this.aggregated.a2aTransportCounts.entries()) {
      a2aTransportBreakdown[k] = v;
    }
    const a2aPeerBreakdown: Record<string, number> = {};
    for (const [k, v] of this.aggregated.a2aPeerCounts.entries()) {
      a2aPeerBreakdown[k] = v;
    }

    return {
      totalExecutions: agg.totalExecutions,
      successfulExecutions: this.aggregated.successCount,
      failedExecutions: this.aggregated.failureCount,
      totalTokensIn: this.aggregated.totalTokensIn,
      totalTokensOut: this.aggregated.totalTokensOut,
      totalCostUsd: this.aggregated.totalCostUsd,
      fallbackCount: this.aggregated.fallbackCount,
      system1Executions: this.aggregated.system1Count,
      system2Executions: this.aggregated.system2Count,
      providerBreakdown,
      avgLatencyMs: agg.averageLatencyMs,
      a2aTasksTotal: this.aggregated.a2aTotalCount,
      a2aTasksSuccess: this.aggregated.a2aSuccessCount,
      a2aTransportBreakdown,
      a2aPeerBreakdown,
      system1HitRate: agg.system1HitRate,
      a2aSuccessRate: agg.a2aSuccessRate,
      averageCostUsd: agg.averageCostUsd,
      ratchetAccepted: this.aggregated.ratchetAcceptedCount,
      ratchetRejected: this.aggregated.ratchetRejectedCount,
      evolutionAttempted: this.aggregated.evolutionAttemptedCount,
      evolutionAccepted: this.aggregated.evolutionAcceptedCount,
      evolutionRejected: this.aggregated.evolutionRejectedCount,
      escrowLockedCount: this.aggregated.escrowLockedCount,
      escrowReleasedCount: this.aggregated.escrowReleasedCount,
      escrowRefundedCount: this.aggregated.escrowRefundedCount,
      totalEscrowLockedUsd: this.aggregated.totalEscrowLockedUsd,
      totalEscrowReleasedUsd: this.aggregated.totalEscrowReleasedUsd,
      totalEscrowRefundedUsd: this.aggregated.totalEscrowRefundedUsd,
    };
  }

  public getHistory(): ExecutionTelemetry[] {
    return [...this.executionHistory];
  }

  public reset(): void {
    this.metrics = {
      totalTasks: 0,
      acceptedTasks: 0,
      rejectedTasks: 0,
      totalProfitAC: 0,
      llmLatencyMs: 0,
    };
    this.aggregated = {
      system1Count: 0,
      system2Count: 0,
      totalCostUsd: 0,
      totalLatencyMs: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      a2aTotalCount: 0,
      a2aSuccessCount: 0,
      ratchetAcceptedCount: 0,
      ratchetRejectedCount: 0,
      evolutionAttemptedCount: 0,
      evolutionAcceptedCount: 0,
      evolutionRejectedCount: 0,
      escrowLockedCount: 0,
      escrowReleasedCount: 0,
      escrowRefundedCount: 0,
      totalEscrowLockedUsd: 0,
      totalEscrowReleasedUsd: 0,
      totalEscrowRefundedUsd: 0,
      successCount: 0,
      failureCount: 0,
      fallbackCount: 0,
      providerCounts: new Map<string, number>(),
      a2aTransportCounts: new Map<string, number>(),
      a2aPeerCounts: new Map<string, number>(),
    };
    this.executionHistory = [];
  }

  public toPrometheusText(): string {
    return this.getPrometheusFormat();
  }

  public exportState(): {
    metrics: AgentTelemetryMetrics;
    aggregated: Record<string, unknown>;
  } {
    return {
      metrics: { ...this.metrics },
      aggregated: {
        ...this.aggregated,
        providerCounts: Object.fromEntries(this.aggregated.providerCounts.entries()),
        a2aTransportCounts: Object.fromEntries(this.aggregated.a2aTransportCounts.entries()),
        a2aPeerCounts: Object.fromEntries(this.aggregated.a2aPeerCounts.entries()),
      },
    };
  }

  public importState(data: {
    metrics?: Partial<AgentTelemetryMetrics>;
    aggregated?: Record<string, unknown>;
  }): void {
    if (!data || typeof data !== 'object') return;
    if (data.metrics && typeof data.metrics === 'object') {
      this.metrics = { ...this.metrics, ...data.metrics };
    }
    if (data.aggregated && typeof data.aggregated === 'object') {
      const { providerCounts, a2aTransportCounts, a2aPeerCounts, ...rest } = data.aggregated as Record<string, any>;
      this.aggregated = {
        ...this.aggregated,
        ...rest,
        providerCounts: new Map(Object.entries(providerCounts || {})),
        a2aTransportCounts: new Map(Object.entries(a2aTransportCounts || {})),
        a2aPeerCounts: new Map(Object.entries(a2aPeerCounts || {})),
      };
    }
  }

  public getPrometheusFormat(): string {
    const agg = this.getAggregatedMetrics();
    return [
      '# HELP agent_tasks_total Total tasks processed by engine',
      '# TYPE agent_tasks_total counter',
      `agent_tasks_total ${this.metrics.totalTasks}`,
      '# HELP agent_tasks_accepted Total tasks accepted by economic triage',
      '# TYPE agent_tasks_accepted counter',
      `agent_tasks_accepted ${this.metrics.acceptedTasks}`,
      '# HELP agent_profit_ac_total Accumulated net profit in Agent Credits',
      '# TYPE agent_profit_ac_total counter',
      `agent_profit_ac_total ${this.metrics.totalProfitAC.toFixed(4)}`,
      '# HELP agent_llm_latency_ms Last execution latency in ms',
      '# TYPE agent_llm_latency_ms gauge',
      `agent_llm_latency_ms ${this.metrics.llmLatencyMs}`,
      '# HELP agent_system1_hit_rate Ratio of tasks served by System 1 fast path',
      '# TYPE agent_system1_hit_rate gauge',
      `agent_system1_hit_rate ${agg.system1HitRate.toFixed(4)}`,
      '# HELP agent_avg_cost_usd Average cost per task execution in USD',
      '# TYPE agent_avg_cost_usd gauge',
      `agent_avg_cost_usd ${agg.averageCostUsd.toFixed(6)}`,
      '# HELP agent_avg_latency_ms Average task latency in ms',
      '# TYPE agent_avg_latency_ms gauge',
      `agent_avg_latency_ms ${agg.averageLatencyMs.toFixed(2)}`,
      '# HELP agent_a2a_success_rate Success rate for A2A delegated tasks',
      '# TYPE agent_a2a_success_rate gauge',
      `agent_a2a_success_rate ${agg.a2aSuccessRate.toFixed(4)}`,
      '# HELP agent_tokens_consumed_total Total tokens consumed (in + out)',
      '# TYPE agent_tokens_consumed_total counter',
      `agent_tokens_consumed_total ${agg.totalTokensConsumed}`,
      '# HELP agent_ratchet_accepted_total Total proposals accepted by Ratchet',
      '# TYPE agent_ratchet_accepted_total counter',
      `agent_ratchet_accepted_total ${this.aggregated.ratchetAcceptedCount}`,
      '# HELP agent_ratchet_rejected_total Total proposals rejected by Ratchet',
      '# TYPE agent_ratchet_rejected_total counter',
      `agent_ratchet_rejected_total ${this.aggregated.ratchetRejectedCount}`,
      '# HELP agent_evolution_attempted_total Total Morphling evolution cycles initiated',
      '# TYPE agent_evolution_attempted_total counter',
      `agent_evolution_attempted_total ${this.aggregated.evolutionAttemptedCount}`,
      '# HELP agent_evolution_accepted_total Total Morphling evolution cycles accepted by Ratchet',
      '# TYPE agent_evolution_accepted_total counter',
      `agent_evolution_accepted_total ${this.aggregated.evolutionAcceptedCount}`,
      '# HELP agent_evolution_rejected_total Total Morphling evolution cycles rejected by Ratchet',
      '# TYPE agent_evolution_rejected_total counter',
      `agent_evolution_rejected_total ${this.aggregated.evolutionRejectedCount}`,
    ].join('\n');
  }
}

export const globalTelemetry = new TelemetryCollector();
