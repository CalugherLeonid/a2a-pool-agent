import type { RatchetPolicy } from '../ratchet.js';
import type { ExecutionPolicy } from './types.js';

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  timeoutMs: 10_000,
  maxMemoryMb: 256,
  minEvaluationScore: 0.7,
  allowNetwork: false,
  allowFileSystem: false,
};

/** Derives a stricter, zero-trust execution policy from ratchet state. */
export function derivePolicyFromRatchet(
  ratchetPolicy: RatchetPolicy,
): ExecutionPolicy {
  const failureSteps = Math.max(0, Math.min(5, ratchetPolicy.strictnessLevel) - 1);
  const doubleCheckPenalty = ratchetPolicy.requireDoubleCheck ? 0.05 : 0;

  return {
    ...DEFAULT_EXECUTION_POLICY,
    timeoutMs: Math.max(
      1_000,
      Math.min(
        DEFAULT_EXECUTION_POLICY.timeoutMs,
        Math.floor(ratchetPolicy.maxTimeoutMs * (1 - failureSteps * 0.05)),
      ),
    ),
    maxMemoryMb: Math.max(
      64,
      DEFAULT_EXECUTION_POLICY.maxMemoryMb - failureSteps * 32,
    ),
    minEvaluationScore: Math.min(
      1,
      DEFAULT_EXECUTION_POLICY.minEvaluationScore + failureSteps * 0.05 + doubleCheckPenalty,
    ),
  };
}
