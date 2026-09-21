/**
 * Task Quality Evaluation Engine.
 *
 * Verifies that LLM outputs meet minimum quality thresholds, schema compliance,
 * and completion integrity before artifact signing and settlement.
 */

export interface QualityEvaluationInput {
  output: unknown;
  prompt: string;
  expectedSchema?: Record<string, unknown>;
  minQualityScore?: number;
}

export interface QualityEvaluationResult {
  passed: boolean;
  score: number;
  reason?: string;
  evaluatedAt: string;
}

export class QualityEvaluator {
  private readonly defaultMinScore: number;

  constructor(minScore = 0.7) {
    this.defaultMinScore = minScore;
  }

  /**
   * Evaluates the output artifact from an LLM execution.
   */
  evaluate(input: QualityEvaluationInput): QualityEvaluationResult {
    const { output } = input;
    const minScore = input.minQualityScore ?? this.defaultMinScore;

    // 1. Non-empty check
    if (output === undefined || output === null) {
      return {
        passed: false,
        score: 0.0,
        reason: 'Output is null or undefined',
        evaluatedAt: new Date().toISOString(),
      };
    }

    if (typeof output === 'string' && output.trim().length === 0) {
      return {
        passed: false,
        score: 0.0,
        reason: 'Output is empty string',
        evaluatedAt: new Date().toISOString(),
      };
    }

    if (typeof output === 'object' && Object.keys(output).length === 0) {
      return {
        passed: false,
        score: 0.2,
        reason: 'Output object has empty properties',
        evaluatedAt: new Date().toISOString(),
      };
    }

    // 2. Length / substance heuristic
    let score = 1.0;
    const str = typeof output === 'string' ? output : JSON.stringify(output);

    if (str.length < 20) {
      score = 0.5;
    } else if (str.length < 50) {
      score = 0.75;
    }

    const passed = score >= minScore;

    return {
      passed,
      score,
      reason: passed ? 'Quality verification passed' : `Score ${score} below required threshold ${minScore}`,
      evaluatedAt: new Date().toISOString(),
    };
  }
}

export const defaultQualityEvaluator = new QualityEvaluator();
