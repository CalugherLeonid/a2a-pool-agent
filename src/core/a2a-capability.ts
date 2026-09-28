/**
 * A2A & Meta-Tool Capability Mixin for AgentCore.
 *
 * Implements the Plugin / Capability Mixin pattern to avoid bloated "God Objects"
 * while keeping AgentCore as the Single Source of Truth for lifecycle orchestration.
 *
 * Coordinates:
 *   - A2AAgentOrchestrator (P2P service delegation & escrow locking)
 *   - MetaToolManager (dynamic AST validation, sandbox execution & ratchet evaluation)
 *   - MetaToolRegistry (versioned meta-tool discovery)
 *   - AgentWallet (optional autonomous spending balance)
 */

import type { RawTask } from './types/index.js';
import type { A2AAgentOrchestrator } from './a2a-orchestrator.js';
import type { MetaToolManager } from './meta-tools/manager.js';
import type { MetaToolRegistry } from './meta-tools/registry.js';
import type {
  A2ATaskExecutionRequest,
  A2ATaskExecutionResult,
  EscrowSystemInterface,
} from './types/a2a.types.js';
import type { MetaToolExecutionResult } from './meta-tools/types.js';
import { AgentWallet } from './agent-wallet.js';
import { AgentIdentity } from '../identity/agent-identity.js';
import { MetaToolKit } from './meta-tools/meta-tool-kit.js';
import type { PeerRegistry } from '../adapters/a2a/peer-registry.js';
import type { A2AHttpTransport } from '../adapters/a2a/http-transport.js';
import type { ReputationSystem } from './reputation.js';
import type { EvalPack } from './eval-pack.js';
import { createLogger } from '../observability/logger.js';

export interface A2ACapabilityConfig {
  orchestrator: A2AAgentOrchestrator;
  metaToolManager: MetaToolManager;
  metaToolRegistry: MetaToolRegistry;
  metaToolKit?: MetaToolKit;
  escrow?: EscrowSystemInterface;
  reputationSystem?: ReputationSystem;
  wallet?: AgentWallet;
  initialBalance?: number;
  identity?: AgentIdentity;
  peerRegistry?: PeerRegistry;
  httpTransport?: A2AHttpTransport;
  evalPack?: EvalPack;
}

export class A2ACapability {
  private readonly log = createLogger('a2a-capability');
  public readonly orchestrator: A2AAgentOrchestrator;
  public readonly metaToolManager: MetaToolManager;
  public readonly metaToolRegistry: MetaToolRegistry;
  public readonly metaToolKit: MetaToolKit;
  public readonly escrow?: EscrowSystemInterface;
  public readonly reputationSystem?: ReputationSystem;
  public readonly wallet?: AgentWallet;
  public readonly identity?: AgentIdentity;
  public readonly evalPack?: EvalPack;
  public peerRegistry?: PeerRegistry;
  public httpTransport?: A2AHttpTransport;

  constructor(config: A2ACapabilityConfig) {
    this.orchestrator = config.orchestrator;
    this.metaToolManager = config.metaToolManager;
    this.metaToolRegistry = config.metaToolRegistry;
    this.evalPack =
      config.evalPack ??
      (typeof (config.metaToolManager as any)?.getEvalPack === 'function'
        ? (config.metaToolManager as any).getEvalPack()
        : undefined);
    this.metaToolKit =
      config.metaToolKit ??
      new MetaToolKit({
        registry: config.metaToolRegistry,
        evalPack: this.evalPack,
        ratchetSystem:
          typeof (config.metaToolManager as any)?.getRatchetSystem === 'function'
            ? (config.metaToolManager as any).getRatchetSystem()
            : undefined,
      });
    this.escrow = config.escrow;
    this.reputationSystem = config.reputationSystem;
    this.identity = config.identity;
    this.peerRegistry = config.peerRegistry;
    this.httpTransport = config.httpTransport;
    this.wallet =
      config.wallet ??
      (config.initialBalance !== undefined
        ? new AgentWallet('agent-wallet', config.initialBalance)
        : undefined);
  }

  /**
   * System 1 check: returns true if the task can be satisfied deterministically
   * by an existing, verified meta-tool in the registry without full LLM generation.
   */
  canHandleDeterministically(task: RawTask): boolean {
    const input =
      task.input && typeof task.input === 'object'
        ? (task.input as Record<string, unknown>)
        : undefined;

    if (task.type === 'meta_tool' && typeof input?.toolId === 'string') {
      return Boolean(this.metaToolRegistry.getLatest(input.toolId));
    }

    return Boolean(this.metaToolRegistry.getLatest(task.type));
  }

  /**
   * System 2 escalation detection: returns true if the task requires
   * peer-to-peer delegation (A2A) or dynamic meta-tool execution with sandbox/escrow.
   */
  isA2ATask(task: RawTask): boolean {
    if (task.type === 'a2a_service' || task.type === 'meta_tool') {
      return true;
    }

    const input =
      task.input && typeof task.input === 'object'
        ? (task.input as Record<string, unknown>)
        : undefined;

    const raw =
      task.raw && typeof task.raw === 'object'
        ? (task.raw as Record<string, unknown>)
        : undefined;

    return Boolean(
      (input && ('providerAgentId' in input || 'toolId' in input)) ||
      (raw && ('providerAgentId' in raw || 'toolId' in raw)),
    );
  }

  /**
   * Executes a registered meta-tool locally through MetaToolManager,
   * passing it through sandbox isolation and the Ratchet system.
   */
  async executeMetaTool(
    toolId: string,
    parameters: Record<string, unknown> = {},
    targetVersion?: number,
  ): Promise<MetaToolExecutionResult> {
    this.log.info({ toolId, targetVersion }, 'executing meta-tool locally');
    return this.metaToolManager.execute(toolId, parameters, targetVersion);
  }

  /**
   * Executes an A2A service task using the orchestrator with escrow locking.
   * Enforces zero-trust cryptographic verification on incoming signed requests.
   */
  async executeTask(
    request: A2ATaskExecutionRequest,
  ): Promise<A2ATaskExecutionResult> {
    this.log.info(
      {
        taskId: request.taskId,
        toolId: request.toolId,
        provider: request.providerAgentId,
        client: request.clientAgentId,
        cost: request.costUsd,
      },
      'delegating task via A2A orchestrator',
    );

    // Cryptographic passport verification (zero-trust)
    if (request.signature) {
      const verification = AgentIdentity.verifyA2ARequest(request);
      if (!verification.valid) {
        this.log.warn(
          { taskId: request.taskId, error: verification.error },
          'cryptographic signature rejected on incoming A2A request',
        );
        return {
          success: false,
          error: `Cryptographic verification failed: ${verification.error}`,
          escrowStatus: 'failed',
          metrics: { latencyMs: 0, costUsd: 0 },
        };
      }
    } else if (this.identity && request.clientAgentId === this.identity.agentId) {
      // Auto-sign outbound request with client's passport
      request = this.identity.signA2ARequest(request, request.timeoutMs ?? 60_000);
    }

    if (this.wallet && !this.wallet.canAfford(request.costUsd)) {
      return {
        success: false,
        error: `Insufficient wallet balance (${this.wallet.getBalance()} < ${request.costUsd})`,
        escrowStatus: 'failed',
        metrics: { latencyMs: 0, costUsd: 0 },
      };
    }

    const peer = this.peerRegistry?.getPeer(request.providerAgentId);
    let result: A2ATaskExecutionResult;

    if (
      peer?.endpoints?.http &&
      this.httpTransport &&
      request.clientAgentId !== request.providerAgentId
    ) {
      this.log.info(
        { peer: peer.agentId, url: peer.endpoints.http, taskId: request.taskId },
        'dispatching A2A task to external peer via HTTP transport with escrow protection',
      );

      const startTime = Date.now();
      let httpEscrowId: string | undefined;

      // 1. Lock funds in Escrow prior to external dispatch if escrow system configured
      if (this.escrow) {
        const lock = await this.escrow.lockFunds({
          taskId: request.taskId,
          amount: request.costUsd,
          from: request.clientAgentId,
          to: request.providerAgentId,
        });

        if (!lock.success || !lock.escrowId) {
          return {
            success: false,
            error: lock.error ?? 'Escrow lock failed for HTTP peer delegation',
            escrowStatus: 'failed',
            metrics: { latencyMs: 0, costUsd: 0 },
          };
        }
        httpEscrowId = lock.escrowId;
      }

      // 2. Perform HTTP peer request
      try {
        result = await this.httpTransport.sendA2ARequest(peer.endpoints.http, request);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (this.escrow && httpEscrowId) {
          await this.escrow.refundFunds(request.taskId, httpEscrowId, `http_transport_error:${errMsg}`);
        }
        result = {
          success: false,
          error: `HTTP dispatch error: ${errMsg}`,
          escrowStatus: 'refunded',
          metrics: { latencyMs: Date.now() - startTime, costUsd: request.costUsd },
        };
      }

      // 3. Zero-trust verification of peer's delivery signature if result is signed
      if (result.success && result.signature) {
        const validSig = AgentIdentity.verifyA2AResult(result, request.taskId);
        if (!validSig.valid) {
          this.log.warn(
            { taskId: request.taskId, error: validSig.error },
            'peer result cryptographic signature verification failed - issuing escrow refund',
          );
          if (this.escrow && httpEscrowId) {
            await this.escrow.refundFunds(
              request.taskId,
              httpEscrowId,
              `invalid_peer_signature:${validSig.error}`,
            );
          }
          result = {
            success: false,
            error: `Cryptographic verification of peer delivery failed: ${validSig.error}`,
            escrowStatus: 'refunded',
            metrics: result.metrics,
          };
        }
      }

      // 3.5. Optional EvalPack verification on peer output
      if (result.success && this.evalPack && result.output !== undefined && result.output !== null) {
        try {
          const candidateCode =
            typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output);
          const evalReport = await this.evalPack.evaluate(candidateCode, {
            toolId: request.toolId,
            parameters: request.parameters,
          });
          if (!evalReport.passed) {
            const reason = `EvalPack verification failed: ${evalReport.failures?.join('; ') || 'rules not met'}`;
            if (this.escrow && httpEscrowId) {
              await this.escrow.refundFunds(request.taskId, httpEscrowId, reason);
            }
            result = {
              success: false,
              output: result.output,
              error: reason,
              escrowStatus: 'refunded',
              metrics: result.metrics,
            };
          }
        } catch (evalErr) {
          const reason = `EvalPack evaluation error: ${evalErr instanceof Error ? evalErr.message : String(evalErr)}`;
          if (this.escrow && httpEscrowId) {
            await this.escrow.refundFunds(request.taskId, httpEscrowId, reason);
          }
          result = {
            success: false,
            output: result.output,
            error: reason,
            escrowStatus: 'refunded',
            metrics: result.metrics,
          };
        }
      }

      // 4. Release funds on successful delivery or refund on failure
      if (this.escrow && httpEscrowId) {
        if (result.success) {
          const rel = await this.escrow.releaseFunds(request.taskId, httpEscrowId);
          if (rel.success) {
            result.escrowStatus = 'released';
          } else {
            await this.escrow.refundFunds(request.taskId, httpEscrowId, 'escrow_release_failed');
            result.escrowStatus = 'refunded';
            result.success = false;
            result.error = rel.error ?? 'Escrow release failed';
          }
        } else if (result.escrowStatus !== 'refunded') {
          await this.escrow.refundFunds(
            request.taskId,
            httpEscrowId,
            result.error ?? 'peer_delivery_failed',
          );
          result.escrowStatus = 'refunded';
        }
      }

      // 5. Record feedback in ReputationSystem for external peer
      if (this.reputationSystem) {
        const latency = Date.now() - startTime;
        this.reputationSystem.recordFeedback({
          taskId: request.taskId,
          agentId: request.providerAgentId,
          success: result.success,
          latencyMs: latency,
          deadlineMs: request.timeoutMs ?? 30_000,
          evalScore: result.success ? 1.0 : 0.0,
          ratchetAccepted: result.success,
          notes: result.error,
        });
      }
    } else {
      result = await this.orchestrator.executeA2ATask(request);
    }

    if (!result.telemetry) {
      const isHttp = Boolean(
        peer?.endpoints?.http &&
        this.httpTransport &&
        request.clientAgentId !== request.providerAgentId
      );
      result.telemetry = {
        provider: 'peer',
        model: request.toolId,
        latencyMs: result.metrics?.latencyMs ?? 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: result.metrics?.costUsd ?? request.costUsd,
        fallbackUsed: false,
        fallbackChain: [isHttp ? 'http-peer' : 'local-peer'],
        systemPath: 'system2',
        timestamp: new Date().toISOString(),
        peerId: request.providerAgentId,
        transport: isHttp ? 'http' : 'local',
      };
    }

    if (result.success && result.escrowStatus === 'released' && this.wallet) {
      this.wallet.deduct(result.metrics.costUsd);
    }

    // Auto-sign execution artifact if provider has an identity
    if (this.identity) {
      result = this.identity.signA2AResult(result, request.taskId);
    }

    return result;
  }

  /**
   * Translates a RawTask from a marketplace adapter into an A2A request
   * and runs it through the orchestrator.
   */
  async executeTaskFromRaw(
    task: RawTask,
    clientAgentId: string,
  ): Promise<A2ATaskExecutionResult> {
    const input =
      task.input && typeof task.input === 'object'
        ? (task.input as Record<string, unknown>)
        : {};
    const raw =
      task.raw && typeof task.raw === 'object'
        ? (task.raw as Record<string, unknown>)
        : {};

    const toolId =
      (input.toolId as string) ||
      (raw.toolId as string) ||
      task.type;

    const providerAgentId =
      (input.providerAgentId as string) ||
      (raw.providerAgentId as string) ||
      clientAgentId;

    const parameters =
      (input.parameters as Record<string, unknown>) ||
      input ||
      {};

    const timeoutMs =
      task.deadlineS !== undefined && task.deadlineS > 0
        ? task.deadlineS * 1000
        : 30_000;

    let request: A2ATaskExecutionRequest = {
      taskId: task.id,
      toolId,
      parameters,
      costUsd: task.budgetEstimateUsd,
      clientAgentId,
      providerAgentId,
      timeoutMs,
    };

    if (this.identity) {
      request = this.identity.signA2ARequest(request, timeoutMs);
    }

    return this.executeTask(request);
  }

  /** Returns current wallet balance if autonomous wallet is enabled */
  getWalletBalance(): number | undefined {
    return this.wallet?.getBalance();
  }
}
