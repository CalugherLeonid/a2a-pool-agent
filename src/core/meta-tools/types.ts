export interface MetaToolDefinition {
  id: string;
  name: string;
  description: string;
  sourceCode: string;
  language: string;
  version: number;
  parametersSchema: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionPolicy {
  timeoutMs: number;
  maxMemoryMb: number;
  minEvaluationScore: number;
  allowNetwork: boolean;
  allowFileSystem: boolean;
}

export interface MetaToolExecutionResult {
  success: boolean;
  output: unknown;
  error?: string;
  evaluationScore: number;
  ratchetDecision: 'accepted' | 'rejected' | 'rolled_back';
  metrics: Record<string, number>;
  toolVersionUsed: number;
}
