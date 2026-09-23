import type { EvalReport } from './eval-pack.js';

export interface RatchetPolicy {
  strictnessLevel: number;
  maxTimeoutMs: number;
  requireDoubleCheck: boolean;
}

export interface RatchetResult {
  action: 'accept' | 'rollback' | 'tighten';
  newPolicy: RatchetPolicy;
  reason: string;
}

const DEFAULT_POLICY: RatchetPolicy = {
  strictnessLevel: 1,
  maxTimeoutMs: 10_000,
  requireDoubleCheck: false,
};

/** Applies progressively stricter execution controls after failed evaluations. */
export class RatchetSystem {
  private policy: RatchetPolicy;

  constructor(initialPolicy: Partial<RatchetPolicy> = {}) {
    this.policy = this.normalizePolicy({
      strictnessLevel:
        initialPolicy.strictnessLevel ?? DEFAULT_POLICY.strictnessLevel,
      maxTimeoutMs: initialPolicy.maxTimeoutMs ?? DEFAULT_POLICY.maxTimeoutMs,
      requireDoubleCheck:
        initialPolicy.requireDoubleCheck ?? DEFAULT_POLICY.requireDoubleCheck,
    });
  }

  processEvaluation(report: EvalReport): RatchetResult {
    if (report.passed) {
      return {
        action: 'accept',
        newPolicy: this.getCurrentPolicy(),
        reason: 'Evaluation passed all rules.',
      };
    }

    this.policy = {
      strictnessLevel: Math.min(5, this.policy.strictnessLevel + 1),
      maxTimeoutMs: Math.max(1_000, Math.floor(this.policy.maxTimeoutMs * 0.8)),
      requireDoubleCheck: true,
    };

    return {
      action: 'rollback',
      newPolicy: this.getCurrentPolicy(),
      reason:
        `Evaluation failed (${report.failures.length} rule(s), score ${report.score.toFixed(2)}); ` +
        'the state was rolled back and the security policy tightened.',
    };
  }

  getCurrentPolicy(): RatchetPolicy {
    return { ...this.policy };
  }

  private normalizePolicy(policy: RatchetPolicy): RatchetPolicy {
    const strictnessLevel = Number.isFinite(policy.strictnessLevel)
      ? policy.strictnessLevel
      : DEFAULT_POLICY.strictnessLevel;
    const maxTimeoutMs = Number.isFinite(policy.maxTimeoutMs)
      ? policy.maxTimeoutMs
      : DEFAULT_POLICY.maxTimeoutMs;

    return {
      strictnessLevel: Math.min(5, Math.max(1, Math.floor(strictnessLevel))),
      maxTimeoutMs: Math.max(1_000, Math.floor(maxTimeoutMs)),
      requireDoubleCheck: policy.requireDoubleCheck,
    };
  }
}
