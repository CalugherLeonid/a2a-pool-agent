import type { MetaToolManager } from './meta-tools/manager.js';
import type {
  A2ATaskExecutionRequest,
  A2ATaskExecutionResult,
  EscrowSystemInterface,
} from './types/a2a.types.js';
import type { ExecutionTelemetry } from '../telemetry/types.js';
import type { ReputationSystem } from './reputation.js';
import type { EvalPack } from './eval-pack.js';
import { AgentIdentity } from '../identity/agent-identity.js';
import type { MetaToolExecutionResult } from './meta-tools/types.js';

/** Coordinates escrow-backed, zero-trust execution between two A2A agents. */
export class A2AAgentOrchestrator {
  constructor(
    private readonly metaToolManager: Pick<MetaToolManager, 'execute'>,
    private readonly escrow: EscrowSystemInterface,
    private readonly reputationSystem?: ReputationSystem,
    private readonly evalPack?: EvalPack,
    private readonly identity?: AgentIdentity,
  ) {}

  async executeTask(
    request: A2ATaskExecutionRequest,
  ): Promise<A2ATaskExecutionResult> {
    const startedAt = Date.now();

    // 1. Zero-trust passport verification on incoming request if signed
    if (request.signature) {
      const verification = AgentIdentity.verifyA2ARequest(request);
      if (!verification.valid) {
        return this.result({
          success: false,
          error: `Cryptographic verification failed: ${verification.error}`,
          escrowStatus: 'failed',
          request,
          startedAt,
        });
      }
    }

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

      // 2. Execute with timeout protection
      const timeoutMs = request.timeoutMs ?? 30_000;
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Execution timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      let execution: MetaToolExecutionResult;
      try {
        execution = await Promise.race([
          this.metaToolManager.execute(request.toolId, request.parameters),
          timeoutPromise,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (execution.success && execution.ratchetDecision === 'accepted') {
        // 3. Optional EvalPack verification on output
        let evalPassed = true;
        let evalError: string | undefined;

        if (this.evalPack && execution.output !== undefined && execution.output !== null) {
          try {
            const candidateCode =
              typeof execution.output === 'string'
                ? execution.output
                : JSON.stringify(execution.output);
            const evalReport = await this.evalPack.evaluate(candidateCode, {
              toolId: request.toolId,
              parameters: request.parameters,
            });
            if (!evalReport.passed) {
              evalPassed = false;
              evalError = `EvalPack verification failed: ${evalReport.failures?.join('; ') || 'rules not met'}`;
            }
          } catch (evalErr) {
            evalPassed = false;
            evalError = `EvalPack evaluation error: ${this.errorMessage(evalErr)}`;
          }
        }

        if (!evalPassed) {
          const refund = await this.refundSafely(
            request.taskId,
            escrowId,
            'evalpack_verification_failed',
          );

          if (this.reputationSystem) {
            const latency = Date.now() - startedAt;
            this.reputationSystem.recordFeedback({
              taskId: request.taskId,
              agentId: request.providerAgentId,
              success: false,
              latencyMs: latency,
              deadlineMs: timeoutMs,
              evalScore: 0.0,
              ratchetAccepted: true,
              notes: evalError,
            });
          }

          return this.result({
            success: false,
            output: execution.output,
            error: evalError,
            escrowStatus: refund.escrowStatus,
            ratchetDecision: execution.ratchetDecision,
            request,
            startedAt,
          });
        }

        // 4. Release funds to provider
        const release = await this.escrow.releaseFunds(request.taskId, escrowId);
        if (release.success) {
          if (this.reputationSystem) {
            const latency = Date.now() - startedAt;
            this.reputationSystem.recordFeedback({
              taskId: request.taskId,
              agentId: request.providerAgentId,
              success: true,
              latencyMs: latency,
              deadlineMs: timeoutMs,
              evalScore: execution.evaluationScore ?? 1.0,
              ratchetAccepted: true,
            });
          }

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

        if (this.reputationSystem) {
          const latency = Date.now() - startedAt;
          this.reputationSystem.recordFeedback({
            taskId: request.taskId,
            agentId: request.providerAgentId,
            success: false,
            latencyMs: latency,
            deadlineMs: timeoutMs,
            evalScore: 0.0,
            ratchetAccepted: true,
            notes: 'escrow_release_failed',
          });
        }

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

      if (this.reputationSystem) {
        const latency = Date.now() - startedAt;
        this.reputationSystem.recordFeedback({
          taskId: request.taskId,
          agentId: request.providerAgentId,
          success: false,
          latencyMs: latency,
          deadlineMs: timeoutMs,
          evalScore: execution.evaluationScore ?? 0.0,
          ratchetAccepted: false,
          notes: reason,
        });
      }

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
      const isTimeout = failureMessage.toLowerCase().includes('timed out');
      const refundReason = isTimeout
        ? 'timeout_exceeded'
        : `unexpected_orchestration_failure:${failureMessage}`;

      const refund = escrowId
        ? await this.refundSafely(request.taskId, escrowId, refundReason)
        : { escrowStatus: 'failed' as const, error: undefined };

      if (this.reputationSystem) {
        const latency = Date.now() - startedAt;
        this.reputationSystem.recordFeedback({
          taskId: request.taskId,
          agentId: request.providerAgentId,
          success: false,
          timedOut: isTimeout,
          metDeadline: !isTimeout,
          latencyMs: latency,
          deadlineMs: request.timeoutMs ?? 30_000,
          evalScore: 0.0,
          notes: failureMessage,
        });
      }

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
    const latencyMs = Date.now() - args.startedAt;
    const telemetry: ExecutionTelemetry = {
      provider: 'peer',
      model: args.request.toolId,
      latencyMs,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: args.request.costUsd,
      fallbackUsed: false,
      fallbackChain: ['a2a-orchestrator'],
      systemPath: 'system2',
      timestamp: new Date().toISOString(),
      peerId: args.request.providerAgentId,
      transport: 'local',
    };

    let executionResult: A2ATaskExecutionResult = {
      success: args.success,
      ...(args.output === undefined ? {} : { output: args.output }),
      ...(args.error ? { error: args.error } : {}),
      escrowStatus: args.escrowStatus,
      ...(args.ratchetDecision ? { ratchetDecision: args.ratchetDecision } : {}),
      metrics: {
        latencyMs,
        costUsd: args.request.costUsd,
      },
      telemetry,
    };

    if (this.identity) {
      executionResult = this.identity.signA2AResult(
        executionResult,
        args.request.taskId,
      );
    }

    return executionResult;
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
