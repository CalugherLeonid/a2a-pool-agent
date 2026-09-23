import type { MetaToolManager } from './meta-tools/manager.js';
import type {
  A2ATaskExecutionRequest,
  A2ATaskExecutionResult,
  EscrowSystemInterface,
} from './types/a2a.types.js';

/** Coordinates escrow-backed, zero-trust execution between two A2A agents. */
export class A2AAgentOrchestrator {
  constructor(
    private readonly metaToolManager: Pick<MetaToolManager, 'execute'>,
    private readonly escrow: EscrowSystemInterface,
  ) {}

  async executeTask(
    request: A2ATaskExecutionRequest,
  ): Promise<A2ATaskExecutionResult> {
    const startedAt = Date.now();
    let escrowId: string | undefined;

    try {
      const lock = await this.escrow.lockFunds({
        taskId: request.taskId,
        amount: request.costUsd,
        from: request.clientAgentId,
        to: request.providerAgentId,
      });

      if (!lock.success || !lock.escrowId) {
        return this.result({
          success: false,
          error: lock.error ?? 'Escrow lock failed or did not return an escrow id.',
          escrowStatus: 'failed',
          request,
          startedAt,
        });
      }
      escrowId = lock.escrowId;

      const execution = await this.metaToolManager.execute(
        request.toolId,
        request.parameters,
      );

      if (execution.success && execution.ratchetDecision === 'accepted') {
        const release = await this.escrow.releaseFunds(request.taskId, escrowId);
        if (release.success) {
          return this.result({
            success: true,
            output: execution.output,
            escrowStatus: 'released',
            ratchetDecision: execution.ratchetDecision,
            request,
            startedAt,
          });
        }

        const refund = await this.refundSafely(
          request.taskId,
          escrowId,
          'escrow_release_failed',
        );
        return this.result({
          success: false,
          output: execution.output,
          error: release.error ?? refund.error ?? 'Escrow release failed.',
          escrowStatus: refund.escrowStatus,
          ratchetDecision: execution.ratchetDecision,
          request,
          startedAt,
        });
      }

      const reason = this.rejectionReason(execution.ratchetDecision);
      const refund = await this.refundSafely(request.taskId, escrowId, reason);
      return this.result({
        success: false,
        output: execution.output,
        error: `${reason}: ${execution.error ?? refund.error ?? 'Meta-tool execution rejected.'}`,
        escrowStatus: refund.escrowStatus,
        ratchetDecision: execution.ratchetDecision,
        request,
        startedAt,
      });
    } catch (err) {
      const failureMessage = this.errorMessage(err);
      const refund = escrowId
        ? await this.refundSafely(
            request.taskId,
            escrowId,
            `unexpected_orchestration_failure:${failureMessage}`,
          )
        : { escrowStatus: 'failed' as const, error: undefined };
      return this.result({
        success: false,
        error: `Unexpected orchestration failure: ${failureMessage}`,
        escrowStatus: refund.escrowStatus,
        request,
        startedAt,
      });
    }
  }

  /** Backward-compatible A2A-specific entry point. */
  async executeA2ATask(
    request: A2ATaskExecutionRequest,
  ): Promise<A2ATaskExecutionResult> {
    return this.executeTask(request);
  }

  private async refundSafely(
    taskId: string,
    escrowId: string,
    reason: string,
  ): Promise<{ escrowStatus: 'refunded' | 'failed'; error?: string }> {
    try {
      const refund = await this.escrow.refundFunds(taskId, escrowId, reason);
      return refund.success
        ? { escrowStatus: 'refunded' }
        : { escrowStatus: 'failed', error: refund.error ?? 'Escrow refund failed.' };
    } catch (err) {
      return { escrowStatus: 'failed', error: this.errorMessage(err) };
    }
  }

  private result(args: {
    success: boolean;
    output?: unknown;
    error?: string;
    escrowStatus: A2ATaskExecutionResult['escrowStatus'];
    ratchetDecision?: string;
    request: A2ATaskExecutionRequest;
    startedAt: number;
  }): A2ATaskExecutionResult {
    return {
      success: args.success,
      ...(args.output === undefined ? {} : { output: args.output }),
      ...(args.error ? { error: args.error } : {}),
      escrowStatus: args.escrowStatus,
      ...(args.ratchetDecision ? { ratchetDecision: args.ratchetDecision } : {}),
      metrics: {
        latencyMs: Date.now() - args.startedAt,
        costUsd: args.request.costUsd,
      },
    };
  }

  private rejectionReason(decision: string): string {
    if (decision === 'rolled_back') return 'ratchet_rolled_back';
    if (decision === 'rejected') return 'ratchet_rejected';
    return 'meta_tool_execution_failed';
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
