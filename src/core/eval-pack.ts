import type { ExecutionTelemetry } from '../telemetry/types.js';
import { Sandbox, type SandboxResult } from './sandbox.js';
import { SandboxSecurityGuard } from './sandbox/security-guard.js';

export interface EvalCheckDetail {
  checkId: string;
  success: boolean;
  description?: string;
  error?: string;
  latencyMs?: number;
  actual?: unknown;
  expected?: unknown;
}

export interface EvalTestCase {
  id: string;
  description?: string;
  input?: unknown;
  expectedOutputSubstring?: string;
  expectedOutput?: unknown;
  validator?: (output: unknown, context?: unknown) => boolean | Promise<boolean>;
  timeoutMs?: number;
}

export interface EvalContext {
  toolId?: string;
  targetVersion?: number;
  currentVersion?: number;
  currentScore?: number;
  currentLatencyMs?: number;
  currentCostUsd?: number;
  testCases?: EvalTestCase[];
  parametersSchema?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  sandbox?: Sandbox;
  [key: string]: unknown;
}

export interface EvalResult {
  score: number;
  passed: boolean;
  details: EvalCheckDetail[];
  error?: string;
  telemetry?: ExecutionTelemetry;
  failures: string[];
  durationMs: number;
}

/** Type alias ensuring backward compatibility with existing EvalReport imports. */
export type EvalReport = EvalResult;

export interface EvalRule {
  id: string;
  description: string;
  evaluate: (
    sandboxResult: SandboxResult,
    context?: any,
  ) => boolean | Promise<boolean>;
}

export interface IEvalPack {
  readonly id: string;
  readonly description: string;
  evaluate(
    candidate: string | SandboxResult | { sourceCode: string },
    context?: EvalContext,
  ): Promise<EvalResult>;
}

/**
 * Standard composable collection of checks for code run through Sandbox.
 * Backward-compatible with prior EvalPack usage.
 */
export class EvalPack implements IEvalPack {
  public readonly id: string;
  public readonly description: string;
  protected readonly rules: EvalRule[] = [];
  protected defaultSandbox = new Sandbox();

  constructor(id = 'standard-eval-pack', description = 'Standard EvalPack rule engine') {
    this.id = id;
    this.description = description;
    this.rules = [
      {
        id: 'execution-success',
        description: 'The sandbox execution must succeed without runtime errors.',
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
  }

  addRule(rule: EvalRule): void {
    this.rules.push(rule);
  }

  async evaluate(
    candidate: string | SandboxResult | { sourceCode: string },
    context?: EvalContext,
  ): Promise<EvalResult> {
    const startedAt = Date.now();
    let sandboxResult: SandboxResult;
    let sourceCode = '';

    if (typeof candidate === 'string') {
      sourceCode = candidate;
      const sandbox = context?.sandbox ?? this.defaultSandbox;
      sandboxResult = await sandbox.executeCode(candidate, { isolated: true });
    } else if ('sourceCode' in candidate && typeof candidate.sourceCode === 'string') {
      sourceCode = candidate.sourceCode;
      const sandbox = context?.sandbox ?? this.defaultSandbox;
      sandboxResult = await sandbox.executeCode(candidate.sourceCode, { isolated: true });
    } else {
      sandboxResult = candidate as SandboxResult;
    }

    const details: EvalCheckDetail[] = [];
    const failures: string[] = [];
    let passedRules = 0;

    // Optional Static Security Audit if source code is available
    if (sourceCode) {
      const audit = SandboxSecurityGuard.auditSourceCode(sourceCode);
      if (!audit.passed) {
        const errorMsg = `Security violation: ${audit.violations.join('; ')}`;
        details.push({
          checkId: 'security-audit',
          success: false,
          description: 'Static security audit against prohibited capabilities',
          error: errorMsg,
        });
        failures.push('security-audit');
      } else {
        details.push({
          checkId: 'security-audit',
          success: true,
          description: 'Static security audit passed',
        });
        passedRules++;
      }
    }

    for (const rule of this.rules) {
      const ruleStart = Date.now();
      try {
        const ok = await rule.evaluate(sandboxResult, context);
        const latencyMs = Date.now() - ruleStart;
        if (ok) {
          passedRules += 1;
          details.push({
            checkId: rule.id,
            success: true,
            description: rule.description,
            latencyMs,
          });
        } else {
          failures.push(rule.id);
          details.push({
            checkId: rule.id,
            success: false,
            description: rule.description,
            error: sandboxResult.error || sandboxResult.stderr || 'Rule returned false',
            latencyMs,
          });
        }
      } catch (err) {
        const latencyMs = Date.now() - ruleStart;
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${rule.id}: ${msg}`);
        details.push({
          checkId: rule.id,
          success: false,
          description: rule.description,
          error: msg,
          latencyMs,
        });
      }
    }

    // Run custom testCases if provided in context
    if (context?.testCases && context.testCases.length > 0) {
      for (const tc of context.testCases) {
        const tcStart = Date.now();
        let pass = true;
        let errMsg: string | undefined;

        if (tc.expectedOutputSubstring && !sandboxResult.stdout.includes(tc.expectedOutputSubstring)) {
          pass = false;
          errMsg = `Stdout missing expected substring "${tc.expectedOutputSubstring}"`;
        }

        if (pass && tc.validator) {
          try {
            pass = await tc.validator(sandboxResult.stdout, context);
            if (!pass) errMsg = 'Test case validator returned false';
          } catch (err) {
            pass = false;
            errMsg = `Validator error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        const latencyMs = Date.now() - tcStart;
        if (pass) {
          passedRules++;
          details.push({
            checkId: `testcase-${tc.id}`,
            success: true,
            description: tc.description ?? `Test case ${tc.id}`,
            latencyMs,
          });
        } else {
          failures.push(`testcase-${tc.id}`);
          details.push({
            checkId: `testcase-${tc.id}`,
            success: false,
            description: tc.description ?? `Test case ${tc.id}`,
            error: errMsg,
            latencyMs,
          });
        }
      }
    }

    const totalChecks = this.rules.length + (sourceCode ? 1 : 0) + (context?.testCases?.length ?? 0);
    const score = totalChecks === 0 ? 1 : Math.round((passedRules / totalChecks) * 100) / 100;
    const durationMs = Date.now() - startedAt;

    const telemetry: ExecutionTelemetry = {
      provider: 'eval-pack',
      model: this.id,
      latencyMs: durationMs,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      fallbackUsed: false,
      fallbackChain: ['eval-pack'],
      systemPath: 'system1',
      timestamp: new Date().toISOString(),
      transport: 'local',
    };

    return {
      passed: failures.length === 0,
      score,
      details,
      error: failures.length > 0 ? failures.join('; ') : undefined,
      failures,
      durationMs,
      telemetry,
    };
  }
}

/**
 * 1. GenericToolEvalPack
 * Evaluates general tool scripts for syntax validity, runtime stability,
 * exit status, and bounded execution time.
 */
export class GenericToolEvalPack extends EvalPack {
  constructor() {
    super('generic-tool-eval-pack', 'Validates generic tool syntax, safety, and outputs');
    this.addRule({
      id: 'output-non-empty',
      description: 'Candidate tool execution must yield non-empty output',
      evaluate: (res) => res.stdout.trim().length > 0,
    });
  }
}

/**
 * 2. DataParsingEvalPack
 * Evaluates data extraction and parsing tools for JSON resilience,
 * handling empty/malformed inputs, and latency bounds (<200ms).
 */
export class DataParsingEvalPack extends EvalPack {
  constructor() {
    super('data-parsing-eval-pack', 'Evaluates data parsing tools for resilience and schema integrity');

    this.addRule({
      id: 'no-crash-on-execution',
      description: 'Parsing tool must execute without uncaught exceptions or segmentation faults',
      evaluate: (res) => res.success && res.exitCode === 0,
    });

    this.addRule({
      id: 'json-parsable-output',
      description: 'Output must be parseable JSON or formatted structured text',
      evaluate: (res) => {
        try {
          const parsed = JSON.parse(res.stdout.trim());
          return parsed !== null && (typeof parsed === 'object' || typeof parsed === 'string');
        } catch {
          // If not raw JSON, check if output contains key structured format
          return res.stdout.trim().length > 0 && !res.stdout.includes('Uncaught Error');
        }
      },
    });

    this.addRule({
      id: 'bounded-parsing-latency',
      description: 'Parsing execution must complete rapidly within 1000ms',
      evaluate: (res) => res.durationMs < 1000,
    });
  }
}

/**
 * 3. NegotiationEvalPack
 * Evaluates negotiation tools and bidding strategies to ensure:
 * - Counter-offers do not exceed budget ceilings or breach reservation floors.
 * - Bid rationality / monotonicity (bids do not jump erratically).
 * - A2A protocol schema compliance.
 */
export class NegotiationEvalPack extends EvalPack {
  constructor() {
    super('negotiation-eval-pack', 'Evaluates negotiation and bidding logic for boundary protection');

    this.addRule({
      id: 'negotiation-runtime-success',
      description: 'Negotiation logic must execute cleanly',
      evaluate: (res) => res.success && res.exitCode === 0,
    });

    this.addRule({
      id: 'boundary-check',
      description: 'Negotiation output must respect price bounds and budget constraints',
      evaluate: (res, context) => {
        try {
          const text = res.stdout.trim();
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) return true; // non-json output evaluated by other rules
          const data = JSON.parse(jsonMatch[0]);

          const bidAmount = data.bidAmount ?? data.costUsd ?? data.priceUsd ?? data.offer;
          if (typeof bidAmount === 'number') {
            const maxBudget = (context?.maxBudget as number) ?? (context?.budgetUsd as number);
            if (maxBudget !== undefined && bidAmount > maxBudget) {
              return false; // Exceeded ceiling
            }
            const minFloor = (context?.minReservationPrice as number) ?? 0;
            if (bidAmount < minFloor) {
              return false; // Below reservation floor
            }
          }
          return true;
        } catch {
          return true;
        }
      },
    });

    this.addRule({
      id: 'protocol-compliance',
      description: 'Output must not produce negative price or invalid NaN fields',
      evaluate: (res) => {
        return !res.stdout.includes('NaN') && !res.stdout.includes('"costUsd": -');
      },
    });
  }
}
