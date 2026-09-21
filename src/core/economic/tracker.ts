export interface ExecutionMetrics {
  taskId: string;
  provider: string;
  estimatedCost: number;
  actualCost: number;
  latencyMs: number;
  won: boolean;
  bidAmount?: number;
  payout?: number;
  timestamp: number;
}

export class EconomicTracker {
  private history: ExecutionMetrics[] = [];

  public recordOutcome(metrics: ExecutionMetrics): void {
    this.history.push(metrics);
  }

  public getWinRate(timeWindowMs?: number): number {
    const now = Date.now();
    const filtered = timeWindowMs
      ? this.history.filter((m) => now - m.timestamp <= timeWindowMs)
      : this.history;

    if (filtered.length === 0) return 0.5;
    const wins = filtered.filter((m) => m.won).length;
    return wins / filtered.length;
  }

  public getCostAccuracyRatio(): number {
    const completed = this.history.filter((m) => m.won && m.actualCost > 0);
    if (completed.length === 0) return 1.0;

    const totalEst = completed.reduce((acc, m) => acc + m.estimatedCost, 0);
    const totalAct = completed.reduce((acc, m) => acc + m.actualCost, 0);
    return totalEst > 0 ? totalAct / totalEst : 1.0;
  }

  public getStats() {
    return {
      totalBids: this.history.length,
      winRate: Number(this.getWinRate().toFixed(4)),
      costAccuracyRatio: Number(this.getCostAccuracyRatio().toFixed(4)),
      netProfit: Number(
        this.history
          .reduce(
            (acc, m) => acc + ((m.payout || 0) - (m.won ? m.actualCost : 0)),
            0
          )
          .toFixed(4)
      ),
    };
  }

  public clearHistory(): void {
    this.history = [];
  }
}