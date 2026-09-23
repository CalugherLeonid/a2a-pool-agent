import type { SandboxResult } from './sandbox.js';

export interface EvalRule {
  id: string;
  description: string;
  evaluate: (
    sandboxResult: SandboxResult,
    context?: any,
  ) => boolean | Promise<boolean>;
}

export interface EvalReport {
  passed: boolean;
  score: number;
  failures: string[];
  durationMs: number;
}

/** A composable collection of checks for code run through a Sandbox. */
export class EvalPack {
  private readonly rules: EvalRule[] = [
    {
      id: 'execution-success',
      description: 'The sandbox execution must succeed.',
      evaluate: (result) => result.success,
    },
    {
      id: 'zero-exit-code',
      description: 'The sandbox process must exit with code 0.',
      evaluate: (result) => result.exitCode === 0,
    },
    {
      id: 'no-timeout',
      description: 'The sandbox execution must not time out.',
      evaluate: (result) => !result.error?.toLowerCase().includes('timeout'),
    },
  ];

  addRule(rule: EvalRule): void {
    this.rules.push(rule);
  }

  async evaluate(
    sandboxResult: SandboxResult,
    context?: any,
  ): Promise<EvalReport> {
    const startedAt = Date.now();
    const failures: string[] = [];
    let passedRules = 0;

    for (const rule of this.rules) {
      try {
        if (await rule.evaluate(sandboxResult, context)) {
          passedRules += 1;
        } else {
          failures.push(rule.id);
        }
      } catch (err) {
        failures.push(`${rule.id}: ${this.errorMessage(err)}`);
      }
    }

    const score = this.rules.length === 0 ? 1 : passedRules / this.rules.length;
    return {
      passed: failures.length === 0,
      score,
      failures,
      durationMs: Date.now() - startedAt,
    };
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
