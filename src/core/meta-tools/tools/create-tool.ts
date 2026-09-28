import { EvalPack } from '../../eval-pack.js';
import type { EvalReport } from '../../eval-pack.js';
import { RatchetSystem } from '../../ratchet.js';
import { Sandbox } from '../../sandbox.js';
import { SandboxSecurityGuard } from '../../sandbox/security-guard.js';
import { MetaToolRegistry } from '../registry.js';
import type { MetaToolDefinition } from '../types.js';

export interface CreateToolInput {
  id: string;
  name: string;
  description?: string;
  sourceCode: string;
  language?: 'javascript' | 'typescript' | 'python';
  parametersSchema?: Record<string, unknown>;
  validateBeforeSave?: boolean;
}

export interface CreateToolOutput {
  success: boolean;
  tool?: MetaToolDefinition;
  evaluationReport?: EvalReport;
  error?: string;
}

/** Validates and registers a new version of a meta-tool through the immune system. */
export class CreateToolTool {
  constructor(
    private readonly registry: MetaToolRegistry,
    private readonly sandbox?: Sandbox,
    private readonly evalPack?: EvalPack,
    private readonly ratchetSystem?: RatchetSystem,
  ) {}

  async execute(input: CreateToolInput): Promise<CreateToolOutput> {
    const validationError = this.validate(input);
    if (validationError) {
      return { success: false, error: validationError };
    }

    const validateBeforeSave = input.validateBeforeSave ?? true;
    let evaluationReport: EvalReport | undefined;

    if (validateBeforeSave) {
      // 1. Static Security Check
      const audit = SandboxSecurityGuard.auditSourceCode(input.sourceCode);
      if (!audit.passed) {
        return {
          success: false,
          error: `Immune system rejected proposal: ${audit.violations.join('; ')}`,
        };
      }

      // 2. Full Ratchet evaluation if available
      if (this.ratchetSystem) {
        const proposalResult = await this.ratchetSystem.evaluateCandidateProposal({
          toolId: input.id,
          sourceCode: input.sourceCode,
          metadata: {
            name: input.name,
            description: input.description,
            parametersSchema: input.parametersSchema,
          },
          currentVersion: 0,
          currentScore: 0,
          evalPack: this.evalPack,
        });

        evaluationReport = proposalResult.evalResult;

        if (!proposalResult.accepted) {
          return {
            success: false,
            evaluationReport,
            error: proposalResult.reason,
          };
        }
      } else {
        if (!this.sandbox || !this.evalPack) {
          return {
            success: false,
            error: 'Sandbox and EvalPack are required when validateBeforeSave is enabled.',
          };
        }

        const sandboxResult = await this.sandbox.executeCode(input.sourceCode);
        try {
          evaluationReport = await this.evalPack.evaluate(sandboxResult, {
            toolId: input.id,
            language: input.language ?? 'javascript',
            parametersSchema: input.parametersSchema ?? {},
          });
        } catch (err) {
          return {
            success: false,
            error: `Tool evaluation failed: ${this.errorMessage(err)}`,
          };
        }

        if (!evaluationReport.passed) {
          return {
            success: false,
            evaluationReport,
            error:
              sandboxResult.error ??
              (sandboxResult.stderr.trim() ||
                `Validation failed: ${evaluationReport.failures.join(', ')}`),
          };
        }
      }
    }

    try {
      const tool = this.registry.register({
        id: input.id.trim(),
        name: input.name.trim(),
        description: input.description ?? '',
        sourceCode: input.sourceCode,
        language: input.language ?? 'javascript',
        parametersSchema: input.parametersSchema ?? {},
      });
      return { success: true, tool, ...(evaluationReport ? { evaluationReport } : {}) };
    } catch (err) {
      return {
        success: false,
        ...(evaluationReport ? { evaluationReport } : {}),
        error: `Tool registration failed: ${this.errorMessage(err)}`,
      };
    }
  }

  private validate(input: CreateToolInput): string | undefined {
    if (!input.id.trim()) return 'Tool id is required.';
    if (!input.name.trim()) return 'Tool name is required.';
    if (!input.sourceCode.trim()) return 'Tool source code is required.';
    return undefined;
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
