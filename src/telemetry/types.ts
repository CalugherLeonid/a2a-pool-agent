export interface ExecutionTelemetry {
  provider: string;
  model: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  fallbackUsed: boolean;
  fallbackChain: string[];
  systemPath: 'system1' | 'system2';
  timestamp: string; // ISO 8601
  peerId?: string; // Present for A2A delegation
  transport?: 'http' | 'ws' | 'local';
}

export interface AggregatedMetrics {
  system1HitRate: number;
  averageCostUsd: number;
  averageLatencyMs: number;
  a2aSuccessRate: number;
  totalTokensConsumed: number;
  totalExecutions: number;
  system1Count: number;
  system2Count: number;
  a2aTotalCount: number;
  a2aSuccessCount: number;
  ratchetAcceptedCount: number;
  ratchetRejectedCount: number;
  evolutionAttemptedCount: number;
  evolutionAcceptedCount: number;
  evolutionRejectedCount: number;
}
