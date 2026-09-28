import { EvalPack } from '../../eval-pack.js';
import type { EvalReport } from '../../eval-pack.js';
import { RatchetSystem } from '../../ratchet.js';
import { Sandbox } from '../../sandbox.js';
import { SandboxSecurityGuard } from '../../sandbox/security-guard.js';
import { MetaToolRegistry } from '../registry.js';
import type { MetaToolDefinition } from '../types.js';

export interface HotReloadInput {
  toolId: string;
  newSourceCode: string;
  description?: string;
  parametersSchema?: Record<string, unknown>;
  currentScore?: number;
  currentLatencyMs?: number;
  currentCostUsd?: number;
}

export interface HotReloadOutput {
  success: boolean;
  tool?: MetaToolDefinition;
  evaluationReport?: EvalReport;
  ratchetDecision: 'accepted' | 'rejected' | 'rolled_back';
  error?: string;
}

/** Validates a candidate source update through the immune system before appending a new tool version. */
export class HotReloadTool {
  constructor(
    private readonly registry: MetaToolRegistry,
    private readonly sandbox?: Sandbox,
    private readonly evalPack?: EvalPack,
    private readonly ratchetSystem?: RatchetSystem,
  ) {}

  async execute(input: HotReloadInput): Promise<HotReloadOutput> {
    const existing = this.registry.getLatest(input.toolId);
    if (!existing) {
      return {
        success: false,
        ratchetDecision: 'rejected',
        error: `Meta-tool '${input.toolId}' was not found.`,
      };
    }

    if (!input.newSourceCode.trim()) {
      return {
        success: false,
        ratchetDecision: 'rejected',
        error: 'New tool source code is required.',
      };
    }

    if (!this.sandbox || !this.evalPack || !this.ratchetSystem) {
      return {
        success: false,
        ratchetDecision: 'rejected',
        error: 'Sandbox, EvalPack, and RatchetSystem are required for hot reload.',
      };
    }

    // 1. Static Security Guard check
    const securityAudit = SandboxSecurityGuard.auditSourceCode(input.newSourceCode);
    if (!securityAudit.passed) {
      const syntheticReport: EvalReport = {
        passed: false,
        score: 0,
        failures: securityAudit.violations,
        durationMs: 0,
        details: [
          {
            checkId: 'security-audit',
            success: false,
            description: 'Static security audit',
            error: securityAudit.violations.join('; '),
          },
        ],
      };
      this.ratchetSystem.processEvaluation(syntheticReport);
      return {
        success: false,
        evaluationReport: syntheticReport,
        ratchetDecision: 'rolled_back',
        error: `Immune system rejected hot reload: ${securityAudit.violations.join('; ')}`,
      };
    }

    // 2. Full Ratchet evaluation
    const proposalResult = await this.ratchetSystem.evaluateCandidateProposal({
      toolId: existing.id,
      sourceCode: input.newSourceCode,
      metadata: {
        name: existing.name,
        description: input.description ?? existing.description,
        parametersSchema: input.parametersSchema ?? existing.parametersSchema,
      },
      currentVersion: existing.version,
      currentCode: existing.sourceCode,
      currentScore: input.currentScore ?? 0.75,
      currentLatencyMs: input.currentLatencyMs,
      currentCostUsd: input.currentCostUsd,
      evalPack: this.evalPack,
    });

    const ratchetDecision = proposalResult.accepted ? 'accepted' : 'rolled_back';

    if (!proposalResult.accepted) {
      return {
        success: false,
        evaluationReport: proposalResult.evalResult,
        ratchetDecision,
        error: proposalResult.reason,
      };
    }

    try {
      const tool = this.registry.register({
        id: existing.id,
        name: existing.name,
        description: input.description ?? existing.description,
        sourceCode: input.newSourceCode,
        language: existing.language,
        parametersSchema: input.parametersSchema ?? existing.parametersSchema,
      });
      return {
        success: true,
        tool,
        evaluationReport: proposalResult.evalResult,
        ratchetDecision: 'accepted',
      };
    } catch (err) {
      return {
        success: false,
        evaluationReport: proposalResult.evalResult,
        ratchetDecision: 'rejected',
        error: `Hot reload registration failed: ${this.errorMessage(err)}`,
      };
    }
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
