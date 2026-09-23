import type { EvalReport } from '../eval-pack.js';
import { EvalPack } from '../eval-pack.js';
import { RatchetSystem } from '../ratchet.js';
import { Sandbox } from '../sandbox.js';
import type { MetaToolExecutionResult } from './types.js';
import { derivePolicyFromRatchet } from './policies.js';
import { MetaToolRegistry } from './registry.js';

/** Coordinates versioned tools through sandboxing, evaluation, and ratcheting. */
export class MetaToolManager {
  constructor(
    private readonly registry: MetaToolRegistry,
    private readonly sandbox: Sandbox,
    private readonly evalPack: EvalPack,
    private readonly ratchetSystem: RatchetSystem,
  ) {}

  async execute(
    toolId: string,
    parameters: Record<string, unknown> = {},
    targetVersion?: number,
  ): Promise<MetaToolExecutionResult> {
    const startedAt = Date.now();
    const tool = targetVersion === undefined
      ? this.registry.getLatest(toolId)
      : this.registry.getVersion(toolId, targetVersion);

    if (!tool) {
      return {
        success: false,
        output: null,
        error: targetVersion === undefined
          ? `Meta-tool not found: ${toolId}`
          : `Meta-tool not found: ${toolId} version ${targetVersion}`,
        evaluationScore: 0,
        ratchetDecision: 'rejected',
        metrics: { latencyMs: Date.now() - startedAt },
        toolVersionUsed: targetVersion ?? 0,
      };
    }

    const policy = derivePolicyFromRatchet(this.ratchetSystem.getCurrentPolicy());
    let parameterPayload: string;
    try {
      parameterPayload = JSON.stringify(parameters);
    } catch (err) {
      return this.rejectedSerializationResult(tool.version, startedAt, err);
    }

    const sandboxResult = await this.sandbox.executeCode(tool.sourceCode, {
      timeoutMs: policy.timeoutMs,
      env: {
        META_TOOL_PARAMETERS: parameterPayload,
        META_TOOL_EXECUTION_POLICY: JSON.stringify(policy),
      },
    });

    const evaluation = await this.evaluateSafely(sandboxResult, {
      toolId: tool.id,
      toolVersion: tool.version,
      parameters,
      policy,
    });
    const effectiveReport = this.applyMinimumScore(evaluation, policy.minEvaluationScore);
    const ratchet = this.ratchetSystem.processEvaluation(effectiveReport);
    const accepted = effectiveReport.passed && ratchet.action === 'accept';

    return {
      success: accepted,
      output: sandboxResult.stdout,
      ...(accepted ? {} : { error: this.failureMessage(sandboxResult, effectiveReport) }),
      evaluationScore: effectiveReport.score,
      ratchetDecision: this.ratchetDecision(ratchet.action),
      metrics: {
        latencyMs: Date.now() - startedAt,
        sandboxDurationMs: sandboxResult.durationMs,
      },
      toolVersionUsed: tool.version,
    };
  }

  private async evaluateSafely(
    sandboxResult: Awaited<ReturnType<Sandbox['executeCode']>>,
    context: Record<string, unknown>,
  ): Promise<EvalReport> {
    try {
      return await this.evalPack.evaluate(sandboxResult, context);
    } catch (err) {
      return {
        passed: false,
        score: 0,
        failures: [`evaluation_error: ${this.errorMessage(err)}`],
        durationMs: 0,
      };
    }
  }

  private applyMinimumScore(report: EvalReport, minimumScore: number): EvalReport {
    if (report.score >= minimumScore) return report;

    return {
      ...report,
      passed: false,
      failures: [
        ...report.failures,
        `minimum_evaluation_score_not_met:${report.score.toFixed(2)}<${minimumScore.toFixed(2)}`,
      ],
    };
  }

  private rejectedSerializationResult(
    toolVersion: number,
    startedAt: number,
    err: unknown,
  ): MetaToolExecutionResult {
    return {
      success: false,
      output: null,
      error: `Parameter serialization failed: ${this.errorMessage(err)}`,
      evaluationScore: 0,
      ratchetDecision: 'rejected',
      metrics: { latencyMs: Date.now() - startedAt },
      toolVersionUsed: toolVersion,
    };
  }

  private failureMessage(
    sandboxResult: Awaited<ReturnType<Sandbox['executeCode']>>,
    report: EvalReport,
  ): string {
    return sandboxResult.error ?? (sandboxResult.stderr.trim() ||
      `Evaluation failed: ${report.failures.join(', ')}`);
  }

  private ratchetDecision(
    action: 'accept' | 'rollback' | 'tighten',
  ): MetaToolExecutionResult['ratchetDecision'] {
    if (action === 'accept') return 'accepted';
    if (action === 'rollback') return 'rolled_back';
    return 'rejected';
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
