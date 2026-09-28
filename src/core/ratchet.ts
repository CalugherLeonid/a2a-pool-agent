import { createLogger } from '../observability/logger.js';
import { globalTelemetry, type TelemetryCollector } from '../telemetry/metrics.js';
import type { ExecutionTelemetry } from '../telemetry/types.js';
import {
  type EvalReport,
  type EvalResult,
  type EvalTestCase,
  type IEvalPack,
  EvalPack,
  GenericToolEvalPack,
  DataParsingEvalPack,
  NegotiationEvalPack,
} from './eval-pack.js';
import { Sandbox, type SandboxOptions } from './sandbox.js';
import { SandboxSecurityGuard } from './sandbox/security-guard.js';

const log = createLogger('ratchet');

export interface RatchetPolicy {
  strictnessLevel: number;
  maxTimeoutMs: number;
  requireDoubleCheck: boolean;
  minDelta?: number;
  maxLatencyIncreaseRatio?: number;
  maxCostIncreaseRatio?: number;
  minEvaluationScore?: number;
}

export interface RatchetResult {
  action: 'accept' | 'rollback' | 'tighten';
  newPolicy: RatchetPolicy;
  reason: string;
}

export interface CodeProposal {
  toolId: string;
  sourceCode: string;
  metadata?: {
    name?: string;
    description?: string;
    author?: string;
    version?: number;
    parametersSchema?: Record<string, unknown>;
    evalPackType?: 'generic' | 'data-parsing' | 'negotiation';
    [key: string]: unknown;
  };
  currentVersion?: number;
  currentCode?: string;
  currentScore?: number;
  currentLatencyMs?: number;
  currentCostUsd?: number;
  evalPack?: IEvalPack | EvalPack;
  testCases?: EvalTestCase[];
  sandboxOptions?: SandboxOptions;
}

export interface RatchetProposalResult {
  accepted: boolean;
  action: 'accept' | 'rollback' | 'tighten' | 'rejected';
  reason: string;
  currentScore: number;
  candidateScore: number;
  scoreDelta: number;
  candidateVersion: number;
  evalResult: EvalResult;
  newPolicy: RatchetPolicy;
  securityChecksPassed: boolean;
  performanceChecksPassed: boolean;
  telemetry?: ExecutionTelemetry;
}

const DEFAULT_POLICY: RatchetPolicy = {
  strictnessLevel: 1,
  maxTimeoutMs: 10_000,
  requireDoubleCheck: false,
  minDelta: 0.05,
  maxLatencyIncreaseRatio: 0.15,
  maxCostIncreaseRatio: 0.15,
  minEvaluationScore: 0.70,
};

/**
 * RatchetSystem (Sistem Imunitar)
 *
 * Implements an immune system for self-modifying code, hot-reloads, and meta-tools:
 * - Runs candidate code in an isolated process sandbox with zeroed secret access.
 * - Enforces zero-trust security checks (no secrets, no main filesystem tampering, no unauthorized spawns).
 * - Enforces monotonic score improvement: candidateScore >= currentScore + minDelta (default 0.05).
 * - Enforces performance boundaries: latency and cost must not exceed baseline by > 15%.
 * - On failure: automatic rollback, policy tightening, structured logging, and telemetry tracking.
 * - On success: permits hot-reload and registers the approved version.
 */
export class RatchetSystem {
  private policy: RatchetPolicy;
  private readonly sandbox: Sandbox;
  private readonly telemetry: TelemetryCollector;

  constructor(
    initialPolicy: Partial<RatchetPolicy> = {},
    options: { sandbox?: Sandbox; telemetry?: TelemetryCollector } = {},
  ) {
    this.policy = this.normalizePolicy({
      strictnessLevel: initialPolicy.strictnessLevel ?? DEFAULT_POLICY.strictnessLevel,
      maxTimeoutMs: initialPolicy.maxTimeoutMs ?? DEFAULT_POLICY.maxTimeoutMs,
      requireDoubleCheck: initialPolicy.requireDoubleCheck ?? DEFAULT_POLICY.requireDoubleCheck,
      minDelta: initialPolicy.minDelta ?? DEFAULT_POLICY.minDelta,
      maxLatencyIncreaseRatio:
        initialPolicy.maxLatencyIncreaseRatio ?? DEFAULT_POLICY.maxLatencyIncreaseRatio,
      maxCostIncreaseRatio:
        initialPolicy.maxCostIncreaseRatio ?? DEFAULT_POLICY.maxCostIncreaseRatio,
      minEvaluationScore:
        initialPolicy.minEvaluationScore ?? DEFAULT_POLICY.minEvaluationScore,
    });
    this.sandbox = options.sandbox ?? new Sandbox();
    this.telemetry = options.telemetry ?? globalTelemetry;
  }

  /**
   * Evaluates a new code proposal against the immune system rules.
   * Compares the candidate to the active version using EvalPack and strict acceptance criteria.
   */
  async evaluateCandidateProposal(proposal: CodeProposal): Promise<RatchetProposalResult> {
    const startedAt = Date.now();
    const currentScore = proposal.currentScore ?? 0;
    const currentVersion = proposal.currentVersion ?? 0;
    const targetVersion = currentVersion + 1;

    log.info(
      {
        toolId: proposal.toolId,
        currentVersion,
        targetVersion,
        currentScore,
      },
      'Ratchet evaluating candidate code proposal',
    );

    // 1. Static Security Audit (Zero-Trust)
    const securityAudit = SandboxSecurityGuard.auditSourceCode(proposal.sourceCode, {
      allowFileSystem: false,
      allowNetwork: false,
      allowProcessSpawn: false,
    });

    if (!securityAudit.passed) {
      const reason = `Security violation rejected by immune system: ${securityAudit.violations.join('; ')}`;
      log.warn(
        {
          toolId: proposal.toolId,
          violations: securityAudit.violations,
        },
        'Ratchet rejected code proposal: Security violation',
      );

      this.policy = this.tightenPolicy();
      this.telemetry.recordRatchetDecision('rejected', {
        toolId: proposal.toolId,
        reason,
        securityViolation: true,
      });

      const syntheticResult: EvalResult = {
        score: 0,
        passed: false,
        details: [
          {
            checkId: 'security-audit',
            success: false,
            description: 'Static security audit against prohibited capabilities',
            error: reason,
          },
        ],
        failures: ['security-audit'],
        durationMs: Date.now() - startedAt,
      };

      return {
        accepted: false,
        action: 'rollback',
        reason,
        currentScore,
        candidateScore: 0,
        scoreDelta: -currentScore,
        candidateVersion: targetVersion,
        evalResult: syntheticResult,
        newPolicy: this.getCurrentPolicy(),
        securityChecksPassed: false,
        performanceChecksPassed: false,
      };
    }

    // 2. Select Appropriate EvalPack and execute candidate in isolated Sandbox
    let evalPack: IEvalPack = proposal.evalPack ?? new GenericToolEvalPack();
    if (!proposal.evalPack && proposal.metadata?.evalPackType) {
      if (proposal.metadata.evalPackType === 'data-parsing') {
        evalPack = new DataParsingEvalPack();
      } else if (proposal.metadata.evalPackType === 'negotiation') {
        evalPack = new NegotiationEvalPack();
      }
    }

    let evalResult: EvalResult;
    try {
      evalResult = await evalPack.evaluate(proposal.sourceCode, {
        toolId: proposal.toolId,
        targetVersion,
        currentVersion,
        currentScore,
        currentLatencyMs: proposal.currentLatencyMs,
        currentCostUsd: proposal.currentCostUsd,
        testCases: proposal.testCases,
        parametersSchema: proposal.metadata?.parametersSchema,
        sandbox: this.sandbox,
        ...proposal.metadata,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const reason = `Evaluation execution threw critical unhandled exception: ${errMsg}`;
      log.error({ toolId: proposal.toolId, err }, reason);

      this.policy = this.tightenPolicy();
      this.telemetry.recordRatchetDecision('rejected', {
        toolId: proposal.toolId,
        reason,
        error: errMsg,
      });

      return {
        accepted: false,
        action: 'rollback',
        reason,
        currentScore,
        candidateScore: 0,
        scoreDelta: -currentScore,
        candidateVersion: targetVersion,
        evalResult: {
          score: 0,
          passed: false,
          details: [],
          failures: ['evaluation-exception'],
          durationMs: Date.now() - startedAt,
          error: errMsg,
        },
        newPolicy: this.getCurrentPolicy(),
        securityChecksPassed: true,
        performanceChecksPassed: false,
      };
    }

    const candidateScore = evalResult.score;
    const scoreDelta = Math.round((candidateScore - currentScore) * 100) / 100;

    // 3. Strict Acceptance Criteria Checks:
    // A. Zero critical errors
    if (!evalResult.passed || evalResult.error) {
      const reason = `Candidate failed validation rules (${evalResult.failures.join(', ')}).`;
      log.warn({ toolId: proposal.toolId, failures: evalResult.failures }, reason);

      this.policy = this.tightenPolicy();
      this.telemetry.recordRatchetDecision('rejected', {
        toolId: proposal.toolId,
        reason,
        failures: evalResult.failures,
      });

      return {
        accepted: false,
        action: 'rollback',
        reason,
        currentScore,
        candidateScore,
        scoreDelta,
        candidateVersion: targetVersion,
        evalResult,
        newPolicy: this.getCurrentPolicy(),
        securityChecksPassed: true,
        performanceChecksPassed: false,
      };
    }

    // B. Score Improvement Check (candidateScore >= currentScore + minDelta)
    const minDelta = this.policy.minDelta ?? 0.05;
    if (currentVersion > 0) {
      const requiredScore = currentScore + minDelta;
      if (candidateScore < requiredScore) {
        const reason = `Regression / insufficient improvement: Candidate score (${candidateScore.toFixed(
          2,
        )}) is lower than required threshold (${requiredScore.toFixed(2)} with minDelta ${minDelta}). Automatic rollback applied.`;
        log.warn({ toolId: proposal.toolId, candidateScore, currentScore, minDelta }, reason);

        this.policy = this.tightenPolicy();
        this.telemetry.recordRatchetDecision('rolled_back', {
          toolId: proposal.toolId,
          reason,
          candidateScore,
          currentScore,
        });

        return {
          accepted: false,
          action: 'rollback',
          reason,
          currentScore,
          candidateScore,
          scoreDelta,
          candidateVersion: targetVersion,
          evalResult,
          newPolicy: this.getCurrentPolicy(),
          securityChecksPassed: true,
          performanceChecksPassed: true,
        };
      }
    } else {
      // First version / baseline threshold check
      const minScore = this.policy.minEvaluationScore ?? 0.70;
      if (candidateScore < minScore) {
        const reason = `Initial candidate score (${candidateScore.toFixed(
          2,
        )}) does not meet minimum evaluation score (${minScore.toFixed(2)}).`;
        log.warn({ toolId: proposal.toolId, candidateScore, minScore }, reason);

        this.policy = this.tightenPolicy();
        this.telemetry.recordRatchetDecision('rejected', {
          toolId: proposal.toolId,
          reason,
          candidateScore,
          minScore,
        });

        return {
          accepted: false,
          action: 'rollback',
          reason,
          currentScore,
          candidateScore,
          scoreDelta,
          candidateVersion: targetVersion,
          evalResult,
          newPolicy: this.getCurrentPolicy(),
          securityChecksPassed: true,
          performanceChecksPassed: true,
        };
      }
    }

    // C. Performance Bounds Check (Latency & Cost <= +15%)
    const maxLatencyRatio = this.policy.maxLatencyIncreaseRatio ?? 0.15;
    if (proposal.currentLatencyMs && proposal.currentLatencyMs > 0) {
      const candidateLatency = evalResult.durationMs;
      const maxAllowedLatency = proposal.currentLatencyMs * (1 + maxLatencyRatio);
      if (candidateLatency > maxAllowedLatency) {
        const reason = `Performance regression: candidate latency (${candidateLatency}ms) exceeds baseline (${
          proposal.currentLatencyMs
        }ms) by more than ${(maxLatencyRatio * 100).toFixed(0)}% (max allowed: ${Math.round(
          maxAllowedLatency,
        )}ms). Automatic rollback applied.`;
        log.warn({ toolId: proposal.toolId, candidateLatency, maxAllowedLatency }, reason);

        this.policy = this.tightenPolicy();
        this.telemetry.recordRatchetDecision('rolled_back', {
          toolId: proposal.toolId,
          reason,
          candidateLatency,
          currentLatency: proposal.currentLatencyMs,
        });

        return {
          accepted: false,
          action: 'rollback',
          reason,
          currentScore,
          candidateScore,
          scoreDelta,
          candidateVersion: targetVersion,
          evalResult,
          newPolicy: this.getCurrentPolicy(),
          securityChecksPassed: true,
          performanceChecksPassed: false,
        };
      }
    }

    const maxCostRatio = this.policy.maxCostIncreaseRatio ?? 0.15;
    if (
      proposal.currentCostUsd &&
      proposal.currentCostUsd > 0 &&
      evalResult.telemetry &&
      evalResult.telemetry.costUsd > proposal.currentCostUsd * (1 + maxCostRatio)
    ) {
      const reason = `Cost regression: candidate cost ($${evalResult.telemetry.costUsd.toFixed(
        4,
      )}) exceeds baseline ($${proposal.currentCostUsd.toFixed(4)}) by more than ${(
        maxCostRatio * 100
      ).toFixed(0)}%.`;
      log.warn({ toolId: proposal.toolId, cost: evalResult.telemetry.costUsd }, reason);

      this.policy = this.tightenPolicy();
      this.telemetry.recordRatchetDecision('rolled_back', {
        toolId: proposal.toolId,
        reason,
      });

      return {
        accepted: false,
        action: 'rollback',
        reason,
        currentScore,
        candidateScore,
        scoreDelta,
        candidateVersion: targetVersion,
        evalResult,
        newPolicy: this.getCurrentPolicy(),
        securityChecksPassed: true,
        performanceChecksPassed: false,
      };
    }

    // 4. Candidate Accepted! Allow hot-reload & register version
    const reason = `Candidate passed immune system evaluation. Score: ${candidateScore.toFixed(
      2,
    )} (delta: +${scoreDelta.toFixed(2)}). Hot-reload authorized.`;
    log.info(
      {
        toolId: proposal.toolId,
        version: targetVersion,
        candidateScore,
        scoreDelta,
      },
      reason,
    );

    this.telemetry.recordRatchetDecision('accepted', {
      toolId: proposal.toolId,
      version: targetVersion,
      score: candidateScore,
      scoreDelta,
    });

    return {
      accepted: true,
      action: 'accept',
      reason,
      currentScore,
      candidateScore,
      scoreDelta,
      candidateVersion: targetVersion,
      evalResult,
      newPolicy: this.getCurrentPolicy(),
      securityChecksPassed: true,
      performanceChecksPassed: true,
      telemetry: evalResult.telemetry,
    };
  }

  /**
   * Backward-compatible evaluation handler for existing pipelines.
   */
  processEvaluation(report: EvalReport): RatchetResult {
    if (report.passed) {
      this.telemetry.recordRatchetDecision('accepted', {
        score: report.score,
      });
      return {
        action: 'accept',
        newPolicy: this.getCurrentPolicy(),
        reason: 'Evaluation passed all rules.',
      };
    }

    this.policy = this.tightenPolicy();

    this.telemetry.recordRatchetDecision('rolled_back', {
      score: report.score,
      failures: report.failures,
    });

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

  private tightenPolicy(): RatchetPolicy {
    return {
      ...this.policy,
      strictnessLevel: Math.min(5, this.policy.strictnessLevel + 1),
      maxTimeoutMs: Math.max(1_000, Math.floor(this.policy.maxTimeoutMs * 0.8)),
      requireDoubleCheck: true,
    };
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
      requireDoubleCheck: policy.requireDoubleCheck ?? false,
      minDelta: policy.minDelta ?? DEFAULT_POLICY.minDelta,
      maxLatencyIncreaseRatio:
        policy.maxLatencyIncreaseRatio ?? DEFAULT_POLICY.maxLatencyIncreaseRatio,
      maxCostIncreaseRatio:
        policy.maxCostIncreaseRatio ?? DEFAULT_POLICY.maxCostIncreaseRatio,
      minEvaluationScore:
        policy.minEvaluationScore ?? DEFAULT_POLICY.minEvaluationScore,
    };
  }
}
