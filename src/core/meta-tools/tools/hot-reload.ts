import { EvalPack } from '../../eval-pack.js';
import type { EvalReport } from '../../eval-pack.js';
import { RatchetSystem } from '../../ratchet.js';
import { Sandbox } from '../../sandbox.js';
import { MetaToolRegistry } from '../registry.js';
import type { MetaToolDefinition } from '../types.js';

export interface HotReloadInput {
  toolId: string;
  newSourceCode: string;
  description?: string;
  parametersSchema?: Record<string, unknown>;
}

export interface HotReloadOutput {
  success: boolean;
  tool?: MetaToolDefinition;
  evaluationReport?: EvalReport;
  ratchetDecision: 'accepted' | 'rejected' | 'rolled_back';
  error?: string;
}

/** Validates a candidate source update before appending a new tool version. */
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

    const sandboxResult = await this.sandbox.executeCode(input.newSourceCode);
    const evaluationReport = await this.evaluateSafely(sandboxResult, {
      toolId: existing.id,
      currentVersion: existing.version,
      parametersSchema: input.parametersSchema ?? existing.parametersSchema,
    });
    const ratchetResult = this.ratchetSystem.processEvaluation(evaluationReport);
    const ratchetDecision = this.ratchetDecision(ratchetResult.action);

    if (!evaluationReport.passed || ratchetResult.action !== 'accept') {
      return {
        success: false,
        evaluationReport,
        ratchetDecision,
        error: sandboxResult.error ?? (sandboxResult.stderr.trim() ||
          `Hot reload rejected: ${ratchetResult.reason}`),
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
        evaluationReport,
        ratchetDecision,
      };
    } catch (err) {
      return {
        success: false,
        evaluationReport,
        ratchetDecision: 'rejected',
        error: `Hot reload registration failed: ${this.errorMessage(err)}`,
      };
    }
  }

  private async evaluateSafely(
    sandboxResult: Awaited<ReturnType<Sandbox['executeCode']>>,
    context: Record<string, unknown>,
  ): Promise<EvalReport> {
    try {
      return await this.evalPack!.evaluate(sandboxResult, context);
    } catch (err) {
      return {
        passed: false,
        score: 0,
        failures: [`evaluation_error: ${this.errorMessage(err)}`],
        durationMs: 0,
      };
    }
  }

  private ratchetDecision(
    action: 'accept' | 'rollback' | 'tighten',
  ): HotReloadOutput['ratchetDecision'] {
    if (action === 'accept') return 'accepted';
    if (action === 'rollback') return 'rolled_back';
    return 'rejected';
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
