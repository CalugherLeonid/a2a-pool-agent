import { createLogger } from '../observability/logger.js';
import { globalTelemetry } from '../telemetry/metrics.js';
import type { MetaToolKit } from './meta-tools/meta-tool-kit.js';
import type { MetaToolDefinition } from './meta-tools/types.js';
import type { EvalReport } from './eval-pack.js';
import type { AgentIdentity, SignedAgentCard } from '../identity/agent-identity.js';
import type { DynamicAgentCardManager } from './dynamic-agent-card.js';
import type { AgentCard } from '../adapters/a2a/agent-card.js';

export interface EvolutionTrigger {
  reason: 'task_failure' | 'low_quality_score' | 'explicit_request' | 'performance_degradation';
  taskId?: string;
  toolId?: string;
  sourcePath?: string;
  details?: Record<string, unknown>;
}

export interface EvolutionProposal {
  type: 'edit_existing_tool' | 'create_new_tool';
  toolId: string;
  description?: string;
  instruction: string;
  candidateSourceCode: string;
  parametersSchema?: Record<string, unknown>;
  targetPath?: string;
}

export interface EvolutionCycleResult {
  success: boolean;
  cycleId: string;
  trigger: EvolutionTrigger;
  decision: 'accepted' | 'rejected' | 'aborted';
  tool?: MetaToolDefinition;
  evaluationReport?: EvalReport;
  agentCardUpdated?: boolean;
  signedAgentCardJws?: string;
  signedAgentCard?: SignedAgentCard;
  agentCard?: AgentCard;
  cardVersion?: string;
  buildNumber?: number;
  error?: string;
  durationMs: number;
}

export interface MorphlingEvolutionOptions {
  metaToolKit: MetaToolKit;
  identity?: AgentIdentity;
  /** Optional DynamicAgentCardManager for versioning and publishing */
  dynamicCardManager?: DynamicAgentCardManager;
  /** Function to update Agent Card capabilities upon accepted tool evolution */
  onAgentCardUpdate?: (cardPayload: Record<string, unknown>) => Promise<void> | void;
}

/**
 * Morphling Evolution Loop (System 2 Self-Modifying Adaptation).
 *
 * Runs exclusively in System 2:
 *  a. Collect Failure Evidence / Reflection
 *  b. Decide what needs modification (read_source + analysis)
 *  c. Propose candidate code (edit_source or create_tool)
 *  d. Submit proposal through Ratchet (SandboxSecurityGuard -> EvalPack -> Monotonicity gate)
 *  e. If accepted -> hot_reload + bump version + optional signed Agent Card update
 *  f. If rejected -> log rollback + keep original version intact
 *  g. Record telemetries: evolution_attempted, evolution_accepted, evolution_rejected
 */
export class MorphlingEvolutionLoop {
  private readonly log = createLogger('morphling-evolution');

  constructor(private readonly options: MorphlingEvolutionOptions) {}

  /**
   * Executes a complete self-healing / evolution cycle in System 2.
   */
  async executeCycle(
    trigger: EvolutionTrigger,
    proposalOrGenerator:
      | EvolutionProposal
      | ((evidence: Record<string, unknown>) => Promise<EvolutionProposal> | EvolutionProposal),
  ): Promise<EvolutionCycleResult> {
    const cycleId = `evo-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const startTime = Date.now();

    this.log.info({ cycleId, trigger }, 'Initiating Morphling evolution cycle in System 2');
    globalTelemetry.recordEvolution('attempted', { cycleId, trigger });

    // Step A: Collect Failure Evidence / Reflection
    const evidence: Record<string, unknown> = {
      cycleId,
      trigger,
      timestamp: new Date().toISOString(),
    };

    let proposal: EvolutionProposal;
    try {
      if (typeof proposalOrGenerator === 'function') {
        proposal = await proposalOrGenerator(evidence);
      } else {
        proposal = proposalOrGenerator;
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = `Reflection / proposal generation failed: ${this.errorMessage(err)}`;
      this.log.error({ cycleId, err }, errorMsg);
      globalTelemetry.recordEvolution('rejected', { cycleId, error: errorMsg });
      return {
        success: false,
        cycleId,
        trigger,
        decision: 'aborted',
        error: errorMsg,
        durationMs,
      };
    }

    // Step B & C: Inspection via read_source and proposal diff via edit_source
    const existingTool = this.options.metaToolKit.getRegistry().getLatest(proposal.toolId);

    if (existingTool) {
      // Inspect current source safely through System 2 meta-tool
      const readResult = this.options.metaToolKit.readSource(
        { toolId: proposal.toolId },
        'system2',
      );
      evidence.existingSource = readResult.sourceCode;

      // Produce structured diff & static audit with edit_source
      const editResult = this.options.metaToolKit.editSource(
        {
          toolId: proposal.toolId,
          instruction: proposal.instruction,
          proposedCode: proposal.candidateSourceCode,
        },
        'system2',
      );

      if (!editResult.securityChecksPassed) {
        const durationMs = Date.now() - startTime;
        const reason = `Immune security audit rejected proposed edit: ${editResult.securityViolations.join(
          '; ',
        )}`;
        this.log.warn({ cycleId, violations: editResult.securityViolations }, reason);
        globalTelemetry.recordEvolution('rejected', { cycleId, reason });
        return {
          success: false,
          cycleId,
          trigger,
          decision: 'rejected',
          error: reason,
          durationMs,
        };
      }
    }

    // Step D: Submit candidate to RatchetSystem
    let decision: 'accepted' | 'rejected' = 'rejected';
    let evolvedTool: MetaToolDefinition | undefined;
    let evalReport: EvalReport | undefined;
    let failureReason: string | undefined;

    if (proposal.type === 'create_new_tool' || !existingTool) {
      const createResult = await this.options.metaToolKit.createTool(
        {
          id: proposal.toolId,
          name: proposal.toolId,
          description: proposal.description ?? `Evolved tool ${proposal.toolId}`,
          sourceCode: proposal.candidateSourceCode,
          parametersSchema: proposal.parametersSchema ?? {},
          validateBeforeSave: true,
        },
        'system2',
      );

      evalReport = createResult.evaluationReport;
      if (createResult.success && createResult.tool) {
        decision = 'accepted';
        evolvedTool = createResult.tool;
      } else {
        decision = 'rejected';
        failureReason = createResult.error ?? 'Ratchet rejected new tool proposal';
      }
    } else {
      // Existing tool: Hot reload through Ratchet
      const hotReloadResult = await this.options.metaToolKit.hotReload(
        {
          toolId: proposal.toolId,
          newSourceCode: proposal.candidateSourceCode,
          description: proposal.description ?? existingTool.description,
          parametersSchema: proposal.parametersSchema ?? existingTool.parametersSchema,
        },
        'system2',
      );

      evalReport = hotReloadResult.evaluationReport;
      if (hotReloadResult.success && hotReloadResult.tool) {
        decision = 'accepted';
        evolvedTool = hotReloadResult.tool;
      } else {
        decision = 'rejected';
        failureReason =
          hotReloadResult.error ?? `Ratchet rejected update (${hotReloadResult.ratchetDecision})`;
      }
    }

    const durationMs = Date.now() - startTime;

    // Step E: If accepted -> hot_reload complete + update Agent Card
    if (decision === 'accepted' && evolvedTool) {
      this.log.info(
        {
          cycleId,
          toolId: evolvedTool.id,
          newVersion: evolvedTool.version,
          score: evalReport?.score,
        },
        'Morphling evolution proposal ACCEPTED by Ratchet. Tool updated.',
      );

      globalTelemetry.recordEvolution('accepted', {
        cycleId,
        toolId: evolvedTool.id,
        version: evolvedTool.version,
        score: evalReport?.score,
      });

      // Dynamic Agent Card update & re-signing
      let agentCardUpdated = false;
      let signedAgentCardJws: string | undefined;
      let signedAgentCard: SignedAgentCard | undefined;
      let agentCard: AgentCard | undefined;
      let cardVersion: string | undefined;
      let buildNumber: number | undefined;

      if (this.options.dynamicCardManager) {
        const updateResult = this.options.dynamicCardManager.updateCard({
          reason: `Morphling evolution accepted: ${evolvedTool.id} (v${evolvedTool.version})`,
          bumpType: 'patch',
          metadata: {
            cycleId,
            toolId: evolvedTool.id,
            toolVersion: evolvedTool.version,
            score: evalReport?.score,
          },
        });
        agentCardUpdated = updateResult.success;
        signedAgentCard = updateResult.signedCard;
        signedAgentCardJws = updateResult.signedCard.compactJws;
        agentCard = updateResult.card;
        cardVersion = updateResult.version;
        buildNumber = updateResult.buildNumber;

        if (this.options.onAgentCardUpdate) {
          try {
            await this.options.onAgentCardUpdate(agentCard as unknown as Record<string, unknown>);
          } catch (err) {
            this.log.error({ err }, 'onAgentCardUpdate hook failed');
          }
        }
      } else if (this.options.identity) {
        const capabilities = this.options.metaToolKit
          .getRegistry()
          .listLatest()
          .map((t) => ({ id: t.id, name: t.name, version: t.version }));

        const cardPayload = {
          agentId: this.options.identity.agentId,
          capabilities,
          version: `evolved-v${evolvedTool.version}`,
          updatedAt: new Date().toISOString(),
        };

        const signed = this.options.identity.signAgentCard(cardPayload);
        signedAgentCard = signed;
        signedAgentCardJws = signed.compactJws;
        cardVersion = `evolved-v${evolvedTool.version}`;
        agentCardUpdated = true;

        if (this.options.onAgentCardUpdate) {
          try {
            await this.options.onAgentCardUpdate(cardPayload);
          } catch (err) {
            this.log.error({ err }, 'onAgentCardUpdate hook failed');
          }
        }
      }

      return {
        success: true,
        cycleId,
        trigger,
        decision: 'accepted',
        tool: evolvedTool,
        evaluationReport: evalReport,
        agentCardUpdated,
        signedAgentCardJws,
        signedAgentCard,
        agentCard,
        cardVersion,
        buildNumber,
        durationMs,
      };
    }

    // Step F: If rejected -> log + remains on previous version
    this.log.warn(
      { cycleId, toolId: proposal.toolId, reason: failureReason },
      'Morphling evolution proposal REJECTED by Ratchet. Preserving current version.',
    );
    globalTelemetry.recordEvolution('rejected', {
      cycleId,
      toolId: proposal.toolId,
      reason: failureReason,
    });

    return {
      success: false,
      cycleId,
      trigger,
      decision: 'rejected',
      tool: existingTool,
      evaluationReport: evalReport,
      error: failureReason,
      durationMs,
    };
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
