export class TelemetryCollector {
  private metrics = {
    totalTasks: 0,
    acceptedTasks: 0,
    rejectedTasks: 0,
    totalProfitAC: 0,
    llmLatencyMs: 0,
  };

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

  public getPrometheusFormat(): string {
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
    ].join('\n');
  }
}

export const globalTelemetry = new TelemetryCollector();
