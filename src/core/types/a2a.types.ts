import type { ExecutionTelemetry } from '../../telemetry/types.js';

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
  /** Ed25519 cryptographic signature of the request payload */
  signature?: string;
  /** Public key (PEM or hex) of the requesting client agent */
  signerPubkey?: string;
  /** ISO 8601 UTC timestamp when the request was signed */
  timestamp?: string;
  /** Expiration timestamp for replay & delay protection */
  expiresAt?: string;
}

export interface MetaToolExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  ratchetDecision: 'accepted' | 'rejected' | 'rolled_back';
  metrics?: Record<string, unknown>;
  telemetry?: ExecutionTelemetry;
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
  /** Ed25519 cryptographic signature of the result payload */
  signature?: string;
  /** Public key of the provider agent */
  signerPubkey?: string;
  /** ISO 8601 UTC timestamp when result was signed */
  timestamp?: string;
  /** Comprehensive execution telemetry */
  telemetry?: ExecutionTelemetry;
}
