export interface EscrowSystemInterface {
  lockFunds(params: {
    taskId: string;
    amount: number;
    from: string;
    to: string;
  }): Promise<{ success: boolean; escrowId?: string; error?: string }>;

  releaseFunds(
    taskId: string,
    escrowId: string,
  ): Promise<{ success: boolean; error?: string }>;

  refundFunds(
    taskId: string,
    escrowId: string,
    reason: string,
  ): Promise<{ success: boolean; error?: string }>;
}

export interface A2ATaskExecutionRequest {
  /** Unique UUID used as the idempotency key for the task. */
  taskId: string;
  toolId: string;
  parameters?: Record<string, unknown>;
  costUsd: number;
  clientAgentId: string;
  providerAgentId: string;
  /** Defaults to 30 seconds at the execution boundary. */
  timeoutMs?: number;
}

export interface MetaToolExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  ratchetDecision: 'accepted' | 'rejected' | 'rolled_back';
  metrics?: Record<string, unknown>;
}

export interface A2ATaskExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  escrowStatus: 'released' | 'refunded' | 'failed';
  ratchetDecision?: string;
  metrics: {
    latencyMs: number;
    costUsd: number;
  };
}
