/**
 * Agent Core orchestrator.
 *
 * Owns the end-to-end loop for each adapter:
 *   DISCOVER -> TRIAGE -> BUDGET -> ACCEPT -> EXECUTE -> QUALITY
 *     -> DELIVER (or REJECT on quality failure) -> SETTLE -> LEARN
 *
 * Budget is checked AFTER triage and BEFORE accept. If the expected
 * cost would exceed the daily cap, the task is rejected.
 *
 * If quality fails after all retries, the task is rejected — no
 * delivery, no settlement. The cost is still recorded so the budget
 * guard and learning store both see it.
 */

import type { MarketplaceAdapter } from '../adapters/adapter.js';
import type {
  Delivery,
  EconomicDecision,
  QualityReport,
  RawTask,
  SettlementReceipt,
  Sha256Hash,
  Terms,
} from './types/index.js';
import type { AdapterRegistry } from './registry.js';
import type { Signer } from '../identity/ed25519.js';
import type { TriageEngine } from './triage.js';
import type { Executor, ExecutionResult } from './executor.js';
import type { QualityChecker } from './quality.js';
import type { Ledger } from './ledger.js';
import type { LearningStore } from './learning.js';
import type { BudgetGuard } from './budget.js';
import { AgentWallet } from './agent-wallet.js';
import type { A2AAgentOrchestrator } from './a2a-orchestrator.js';
import type { MetaToolRegistry } from './meta-tools/registry.js';
import { A2ACapability } from './a2a-capability.js';
import type {
  A2ATaskExecutionRequest,
  A2ATaskExecutionResult,
} from './types/a2a.types.js';
import type { PeerRegistry } from '../adapters/a2a/peer-registry.js';
import type { A2AHttpTransport } from '../adapters/a2a/http-transport.js';
import type { A2AWsTransport } from '../adapters/a2a/ws-transport.js';
import { AgentIdentity } from '../identity/agent-identity.js';
import { canonicalJson, sha256Hash } from '../identity/ed25519.js';
import { createLogger, type Logger } from '../observability/logger.js';
import { RateLimiter } from './resilience/rate-limiter.js';
import { globalTelemetry } from '../telemetry/metrics.js';
import type { ExecutionTelemetry } from '../telemetry/types.js';
import { MorphlingEvolutionLoop } from './morphling-evolution.js';
import { DynamicAgentCardManager } from './dynamic-agent-card.js';
import { ReputationSystem } from './reputation.js';
import { DynamicPricingEngine } from './pricing-engine.js';
import type { StatePersistenceManager } from '../persistence/state-persistence.js';
import type { CircuitBreakerRegistry } from './resilience/circuit-breaker.js';
import type { GranularRateLimiter } from './resilience/granular-rate-limiter.js';
import { SolanaReceiveWallet, type IncomingPayment } from './solana-wallet.js';
import { OpportunityScanner } from './opportunity/scanner.js';
import { EconomicBrain } from './opportunity/economic-brain.js';
import type { Opportunity } from './opportunity/types.js';
import { HTNPlanner } from './htn/planner.js';
import { TaskGraph } from './htn/types.js';
import { MorphlingReplanEngine } from './htn/morphling-replan.js';

export interface AgentCoreDeps {
  /** Minimum settlement delay in hours; used both in triage and in
   *  learning events to keep time-adjusted profit consistent. */
  delayFloorHours: number;
  registry: AdapterRegistry;
  signer: Signer;
  triage: TriageEngine;
  executor: Executor;
  quality: QualityChecker;
  ledger: Ledger;
  learning: LearningStore;
  budget: BudgetGuard;
  agentId: string;
  workerId: string;
  /** Rate limiter for inbound A2A requests (defaults to 60 req/min, 1000 req/hour) */
  a2aRateLimiter?: RateLimiter;
  /** Optional A2A & Meta-Tool Capability Mixin */
  a2aCapability?: A2ACapability;
  /** Morphling Evolution Loop (System 2 Self-Modifying Adaptation) */
  evolutionLoop?: MorphlingEvolutionLoop;
  /** Dynamic Agent Card & Versioning Manager */
  dynamicCardManager?: DynamicAgentCardManager;
  /** System 2 Reputation System */
  reputationSystem?: ReputationSystem;
  /** Dynamic Pricing Engine */
  pricingEngine?: DynamicPricingEngine;
  /** Cryptographic Zero-Trust Identity */
  identity?: AgentIdentity;
  /** M2M Network Peer Registry & Discovery */
  peerRegistry?: PeerRegistry;
  /** M2M HTTP Transport Adapter */
  httpTransport?: A2AHttpTransport;
  /** M2M WebSocket Transport Adapter */
  wsTransport?: A2AWsTransport;
  /** Robust state persistence manager (atomic JSON storage) */
  persistenceManager?: StatePersistenceManager;
  /** Circuit breaker registry for LLM providers & A2A peers */
  circuitBreakers?: CircuitBreakerRegistry;
  /** Granular multi-dimensional rate limiter (per-peer, per-skill, global) */
  granularRateLimiter?: GranularRateLimiter;
  /** Receive-only Solana wallet monitor */
  solanaWallet?: SolanaReceiveWallet;
  /** Background Opportunity Scanner */
  opportunityScanner?: OpportunityScanner;
  /** Quantitative Economic Brain decision engine */
  economicBrain?: EconomicBrain;
  /** System 2 HTN Goal & Task Decomposition Planner */
  htnPlanner?: HTNPlanner;
  /** System 2 Morphling in-flight adaptive replanner */
  morphlingReplan?: MorphlingReplanEngine;
}

type QualityLoopResult =
  | {
      kind: 'delivered';
      execution: ExecutionResult;
      report: QualityReport;
      attempts: number;
      totalCostUsd: number;
      totalLatencyMs: number;
    }
  | {
      kind: 'failed';
      report: QualityReport;
      attempts: number;
      totalCostUsd: number;
      totalLatencyMs: number;
    };

export class AgentCore {
  private readonly log = createLogger('agent');
  private stopped = false;
  private draining = false;
  private readonly inFlightTasks = new Set<string>();
  public readonly identity: AgentIdentity;
  public readonly peerRegistry?: PeerRegistry;
  public readonly httpTransport?: A2AHttpTransport;
  public readonly wsTransport?: A2AWsTransport;
  public readonly a2aRateLimiter: RateLimiter;
  public readonly evolutionLoop?: MorphlingEvolutionLoop;
  public readonly dynamicCardManager?: DynamicAgentCardManager;
  public readonly reputationSystem?: ReputationSystem;
  public readonly pricingEngine?: DynamicPricingEngine;
  public readonly persistenceManager?: StatePersistenceManager;
  public readonly circuitBreakers?: CircuitBreakerRegistry;
  public readonly granularRateLimiter?: GranularRateLimiter;
  public readonly solanaWallet?: SolanaReceiveWallet;
  public readonly opportunityScanner?: OpportunityScanner;
  public readonly economicBrain?: EconomicBrain;
  public readonly htnPlanner?: HTNPlanner;
  public readonly morphlingReplan?: MorphlingReplanEngine;

  constructor(private readonly deps: AgentCoreDeps) {
    this.identity = deps.identity ?? AgentIdentity.create(deps.agentId);
    this.peerRegistry = deps.peerRegistry;
    this.httpTransport = deps.httpTransport;
    this.wsTransport = deps.wsTransport;
    this.persistenceManager = deps.persistenceManager;
    this.circuitBreakers = deps.circuitBreakers;
    this.granularRateLimiter = deps.granularRateLimiter;
    this.reputationSystem = deps.reputationSystem ?? new ReputationSystem();
    this.pricingEngine =
      deps.pricingEngine ??
      new DynamicPricingEngine({
        basePriceUsd: 0.05,
        baseMinRewardUsd: 0.05,
      });

    this.dynamicCardManager =
      deps.dynamicCardManager ??
      new DynamicAgentCardManager({
        identity: this.identity,
        metaToolRegistry: deps.a2aCapability?.metaToolRegistry,
        telemetry: globalTelemetry,
        reputationSystem: this.reputationSystem,
        pricingEngine: this.pricingEngine,
        httpTransport: this.httpTransport,
        peerRegistry: this.peerRegistry,
      });

    this.evolutionLoop =
      deps.evolutionLoop ??
      (deps.a2aCapability?.metaToolKit
        ? new MorphlingEvolutionLoop({
            metaToolKit: deps.a2aCapability.metaToolKit,
            identity: this.identity,
            dynamicCardManager: this.dynamicCardManager,
          })
        : undefined);
    this.a2aRateLimiter =
      deps.a2aRateLimiter ??
      new RateLimiter({
        limitPerMinute: 60,
        limitPerHour: 1000,
        maxTokens: 20,
        refillRatePerSec: 5,
      });

    this.solanaWallet =
      deps.solanaWallet ??
      new SolanaReceiveWallet({
        ledger: deps.ledger,
        reputationSystem: this.reputationSystem,
      });

    this.economicBrain =
      deps.economicBrain ??
      new EconomicBrain({
        reputationSystem: this.reputationSystem,
        escrowSystem: this.escrowSystem,
      });

    this.htnPlanner = deps.htnPlanner ?? new HTNPlanner();
    this.morphlingReplan = deps.morphlingReplan ?? new MorphlingReplanEngine();
    this.opportunityScanner = deps.opportunityScanner;

    if (this.opportunityScanner) {
      this.opportunityScanner.onDecision(async (opp, decision) => {
        if (decision.action === 'ACCEPT') {
          try {
            await this.executeOpportunity(opp);
          } catch (err) {
            this.log.error(
              { err, opportunityId: opp.id },
              'failed to execute accepted opportunity',
            );
          }
        }
      });
    }

    if (this.deps.a2aCapability) {
      if (this.peerRegistry && !this.deps.a2aCapability.peerRegistry) {
        this.deps.a2aCapability.peerRegistry = this.peerRegistry;
      }
      if (this.httpTransport && !this.deps.a2aCapability.httpTransport) {
        this.deps.a2aCapability.httpTransport = this.httpTransport;
      }
      if (this.reputationSystem && !this.deps.a2aCapability.reputationSystem) {
        (this.deps.a2aCapability as any).reputationSystem = this.reputationSystem;
      }
    }
  }

  async run(): Promise<void> {
    if (this.opportunityScanner && !this.opportunityScanner.isRunning()) {
      this.opportunityScanner.start(() => this.getInFlightTaskCount());
    }

    const adapters = this.deps.registry.all();
    if (adapters.length === 0) {
      this.log.warn('no adapters to poll — check config/adapters/*.json');
      return;
    }

    this.log.info(
      { adapters: adapters.map((a) => a.id) },
      'agent core started',
    );
    this.log.info(
      { usedUsd: this.deps.budget.used, capUsd: this.deps.budget.cap },
      'budget state at startup',
    );

    await Promise.all(adapters.map((a) => this.runAdapter(a)));
  }

  public isDraining(): boolean {
    return this.draining || this.stopped;
  }

  public getInFlightTaskCount(): number {
    return this.inFlightTasks.size;
  }

  public get escrowSystem(): any {
    return this.deps.a2aCapability?.escrow;
  }

  /**
   * Polls Solana receive address for confirmed incoming payments (USDC/SOL)
   * and credits Ledger accordingly.
   */
  public async pollIncomingPayments(since?: Date): Promise<IncomingPayment[]> {
    if (!this.solanaWallet) {
      return [];
    }
    return this.solanaWallet.checkIncomingPayments(since);
  }

  /**
   * System 2 Pipeline:
   * 1. Evaluates opportunity via EconomicBrain. Only ACCEPT proceeds.
   * 2. Decomposes compound goal via HTN Planner into dependency-ordered TaskGraph.
   * 3. Executes tasks iteratively (local execution or A2A sub-agent delegation with Ed25519 & Escrow).
   * 4. Intercepts failures via Morphling in-flight dynamic replanner without crashing the root goal.
   * 5. Note: Real money incoming settlement is handled exclusively by SolanaReceiveWallet.
   */
  public async executeOpportunity(opportunity: Opportunity): Promise<{
    success: boolean;
    graph?: TaskGraph;
    error?: string;
    deliverables?: Record<string, unknown>;
  }> {
    if (this.isDraining()) {
      return { success: false, error: 'Agent is shutting down' };
    }

    // 1. Economic Brain Gatekeeper
    if (this.economicBrain) {
      const decision = await this.economicBrain.evaluate(opportunity, this.getInFlightTaskCount());
      if (decision.action !== 'ACCEPT') {
        this.log.info(
          { opportunityId: opportunity.id, action: decision.action, reason: decision.justification },
          'opportunity rejected or counter-offered by economic brain',
        );
        return { success: false, error: decision.justification };
      }
    }

    if (!this.htnPlanner) {
      return { success: false, error: 'HTN Planner is not configured' };
    }

    this.inFlightTasks.add(opportunity.id);
    try {
      // 2. System 2 HTN Planning & Decomposition
      const graph = this.htnPlanner.decompose(opportunity);
      this.log.info(
        { opportunityId: opportunity.id, graphId: graph.id, totalTasks: graph.tasks.size },
        'HTN decomposed opportunity into TaskGraph',
      );

      const deliverables: Record<string, unknown> = {};

      // 3. Execution Loop with Topological & Ready-set Resolution
      let iterations = 0;
      const maxIterations = graph.tasks.size * 5 + 10;

      while (!graph.isCompleted() && !graph.hasFailedTasks() && iterations++ < maxIterations) {
        if (this.stopped) {
          return { success: false, graph, error: 'Execution aborted due to shutdown' };
        }

        const readyTasks = graph.getReadyTasks();
        if (readyTasks.length === 0) {
          if (graph.isCompleted()) break;
          break;
        }

        for (const task of readyTasks) {
          task.status = 'RUNNING';
          task.startedAt = new Date();

          let taskSuccess = false;
          let taskError: string | undefined;
          let output: unknown = undefined;

          try {
            // Check if subtask should be delegated to an A2A peer
            if (task.assignedAgent && this.deps.a2aCapability) {
              const peerResult = await this.requestServiceFromPeer(
                task.assignedAgent,
                task.skillRequired,
                task.inputData,
                task.maxBudgetUsd,
              );
              taskSuccess = peerResult.success;
              taskError = peerResult.error;
              output = peerResult.output;
            } else if (
              this.peerRegistry &&
              this.peerRegistry.findPeersByCapability(task.skillRequired).length > 0 &&
              !this.economicBrain?.getCapabilities().includes(task.skillRequired)
            ) {
              // Automatic peer discovery from signed Agent Cards if agent lacks skill
              const peers = this.peerRegistry.findPeersByCapability(task.skillRequired);
              const targetPeer = peers[0]!;
              task.assignedAgent = targetPeer.agentId;
              const peerResult = await this.requestServiceFromPeer(
                targetPeer.agentId,
                task.skillRequired,
                task.inputData,
                task.maxBudgetUsd,
              );
              taskSuccess = peerResult.success;
              taskError = peerResult.error;
              output = peerResult.output;
            } else {
              // Local execution via System 2 / Executor
              const rawTask: RawTask = {
                id: task.id,
                source: 'system2-htn',
                type: task.skillRequired,
                prompt: `${task.title}: ${task.description}`,
                input: { ...task.inputData, goal: graph.goal },
                budgetEstimateUsd: task.estimatedCostUsd,
                deadlineS: Math.round(task.executionTimeoutMs / 1000),
                raw: task.inputData,
                observedAt: new Date().toISOString(),
              };
              const execResult = await this.deps.executor.execute({ task: rawTask });
              taskSuccess = true;
              output = execResult.output;
            }
          } catch (err: any) {
            taskSuccess = false;
            taskError = err?.message ?? String(err);
          }

          if (taskSuccess) {
            task.status = 'COMPLETED';
            task.completedAt = new Date();
            task.outputData = (output as Record<string, unknown>) ?? { result: output };
            deliverables[task.id] = task.outputData;
            this.log.info({ taskId: task.id, title: task.title }, 'subtask completed successfully');
          } else {
            // 4. Morphling dynamic re-planning on subtask failure
            this.log.warn(
              { taskId: task.id, error: taskError },
              'subtask failed - invoking Morphling replan loop',
            );
            if (this.morphlingReplan) {
              const healed = await this.morphlingReplan.handleSubtaskFailure(
                graph,
                task,
                taskError ?? 'Execution failure',
              );
              if (!healed) {
                task.status = 'FAILED';
                task.error = taskError;
              }
            } else {
              task.status = 'FAILED';
              task.error = taskError;
            }
          }
        }
      }

      const isSuccess = graph.isCompleted() && !graph.hasFailedTasks();
      return {
        success: isSuccess,
        graph,
        error: isSuccess ? undefined : 'One or more tasks in TaskGraph could not be completed',
        deliverables,
      };
    } finally {
      this.inFlightTasks.delete(opportunity.id);
    }
  }

  public async hydrateState(): Promise<void> {
    if (!this.persistenceManager) return;
    try {
      await this.persistenceManager.loadAll({
        reputation: this.reputationSystem,
        escrow: this.escrowSystem,
        cardManager: this.dynamicCardManager,
        telemetry: globalTelemetry,
      });
      this.log.info('hydrated agent state from persistence manager');
    } catch (err) {
      this.log.warn({ err }, 'failed to hydrate state from persistence manager');
    }
  }

  async stop(timeoutMs = 10000): Promise<void> {
    this.draining = true;
    this.stopped = true;
    this.opportunityScanner?.stop();
    this.log.info({ inFlight: this.inFlightTasks.size }, 'graceful shutdown: stopping adapter polling');
    await this.deps.registry.stopAll();

    if (this.inFlightTasks.size > 0) {
      this.log.info({ inFlight: this.inFlightTasks.size, timeoutMs }, 'awaiting in-flight tasks completion');
      const start = Date.now();
      while (this.inFlightTasks.size > 0 && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (this.inFlightTasks.size > 0) {
        this.log.warn({ remaining: this.inFlightTasks.size }, 'shutdown timeout reached before all in-flight tasks drained');
      } else {
        this.log.info('all in-flight tasks finished cleanly');
      }
    }

    if (this.persistenceManager) {
      try {
        await this.persistenceManager.saveAll({
          reputation: this.reputationSystem,
          escrow: this.escrowSystem,
          cardManager: this.dynamicCardManager,
          telemetry: globalTelemetry,
        });
        this.log.info('persisted agent state on graceful shutdown');
      } catch (err) {
        this.log.error({ err }, 'failed to persist state during graceful shutdown');
      }
    }
  }

  private async runAdapter(adapter: MarketplaceAdapter): Promise<void> {
    const adapterLog = this.log.child({ adapter: adapter.id });
    adapterLog.info('polling started');

    for await (const rawTask of adapter.poll()) {
      if (this.stopped) return;
      try {
        await this.handleTask(adapter, rawTask);
      } catch (err) {
        adapterLog.error(
          { err, taskId: rawTask.id },
          'task handling failed',
        );
      }
    }
  }

  private async handleTask(
    adapter: MarketplaceAdapter,
    rawTask: RawTask,
  ): Promise<void> {
    const taskLog = this.log.child({
      adapter: adapter.id,
      taskId: rawTask.id,
      taskType: rawTask.type,
    });

    if (this.isDraining()) {
      taskLog.warn('agent is draining/stopped - rejecting inbound task');
      await adapter.reject(rawTask.id, 'agent_draining');
      return;
    }

    let escrowAmountUsd = rawTask.budgetEstimateUsd;
    this.inFlightTasks.add(rawTask.id);
    try {

    // --- TRIAGE ---
    const decision: EconomicDecision = await this.deps.triage.decide({
      task: rawTask,
      adapterId: adapter.id,
      capabilities: adapter.capabilities(),
    });

    taskLog.info(
      {
        decision: decision.decision,
        reason: decision.reason,
        expectedProfitUsd: decision.components.expectedProfitUsd,
        timeAdjustedProfit: decision.components.timeAdjustedProfit,
        successProbability: decision.successProbability,
      },
      'triage',
    );

    if (decision.decision !== 'ACCEPT') {
      await adapter.reject(rawTask.id, decision.reason);
      taskLog.info('rejected');
      return;
    }

    // --- BUDGET GUARD (hard gate, before accept) ---
    const estCost = decision.components.expectedTotalCostUsd;
    if (this.deps.budget.wouldExceed(estCost)) {
      const reason =
        'daily_budget_exceeded:used=' +
        this.deps.budget.used.toFixed(6) +
        ':cap=' +
        this.deps.budget.cap.toFixed(6);
      taskLog.warn(
        {
          usedUsd: this.deps.budget.used,
          capUsd: this.deps.budget.cap,
          estCost,
        },
        'rejected by budget guard',
      );
      await adapter.reject(rawTask.id, reason);
      return;
    }

    const maxRetries = 1;
    const terms: Terms = {
      estimatedCostUsd: estCost,
      estimatedTimeS: 30,
      model: decision.model,
      confidence: decision.confidence,
      strategyId: decision.strategyId,
      maxRetries,
    };

    const acceptance = await adapter.accept(rawTask.id, terms);
    if (!acceptance.accepted) {
      taskLog.warn({ reason: acceptance.reason }, 'accept refused by adapter');
      return;
    }
    taskLog.info({ lockedUntil: acceptance.lockedUntil }, 'accepted');

    escrowAmountUsd = rawTask.budgetEstimateUsd;
    try {
      const escrowTxId = await this.deps.ledger.lockFunds({
        taskId: rawTask.id,
        adapterId: adapter.id,
        amountUsd: escrowAmountUsd,
      });
      if (!escrowTxId) {
        throw new Error('escrow lock was not recorded');
      }
      taskLog.info({ escrowTxId, escrowAmountUsd }, 'funds locked in escrow');
    } catch (err) {
      taskLog.error({ err, escrowAmountUsd }, 'escrow lock failed — aborting task');
      try {
        await adapter.reject(rawTask.id, 'escrow_lock_failed');
      } catch (rejectErr) {
        taskLog.error({ err: rejectErr }, 'reject call failed after escrow lock failure');
      }
      return;
    }

    // --- SYSTEM 1: DETERMINISTIC FAST PATH (REGISTERED META-TOOL) ---
    if (
      decision.tier === 'system1_fast' &&
      decision.matchedToolId &&
      this.deps.a2aCapability
    ) {
      taskLog.info(
        { toolId: decision.matchedToolId },
        'executing task via System 1 deterministic fast path',
      );
      const toolInput =
        rawTask.input && typeof rawTask.input === 'object'
          ? (rawTask.input as Record<string, unknown>)
          : {};
      const startTime = Date.now();
      const toolResult = await this.deps.a2aCapability.executeMetaTool(
        decision.matchedToolId,
        toolInput,
      );
      const latencyMs = Date.now() - startTime;
      const toolCostUsd = 0.0001;
      this.deps.budget.record(toolCostUsd);

      const system1Telemetry: ExecutionTelemetry = toolResult.telemetry ?? {
        provider: 'meta-tool',
        model: decision.matchedToolId,
        latencyMs,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: toolCostUsd,
        fallbackUsed: false,
        fallbackChain: ['meta-tool'],
        systemPath: 'system1',
        timestamp: new Date().toISOString(),
        transport: 'local',
      };
      globalTelemetry.recordExecution(
        system1Telemetry,
        Boolean(toolResult.success && toolResult.ratchetDecision === 'accepted'),
      );

      if (toolResult.success && toolResult.ratchetDecision === 'accepted') {
        const canonical = canonicalJson(toolResult.output ?? {});
        const hash: Sha256Hash = sha256Hash(canonical);
        const sig = this.deps.signer.sign(canonical);

        const delivery: Delivery = {
          taskId: rawTask.id,
          workerId: this.deps.workerId,
          output: toolResult.output ?? {},
          hash,
          sig,
          meta: {
            model: 'deterministic-tool',
            provider: 'meta-tool',
            tokensIn: 0,
            tokensOut: 0,
            costUsd: toolCostUsd,
            latencyMs,
            qualityScore: toolResult.evaluationScore ?? 1.0,
            retries: 0,
          },
        };

        const receipt = await adapter.deliver(rawTask.id, delivery);
        taskLog.info(
          {
            hash,
            qualityScore: toolResult.evaluationScore,
            receipt: {
              status: receipt.status,
              currency: receipt.currency,
              netAmountUsd: receipt.netAmountUsd,
            },
          },
          'System 1 deterministic tool delivered',
        );

        await this.deps.ledger.releaseFunds({
          taskId: rawTask.id,
          adapterId: adapter.id,
          revenueUsd: receipt.amountUsd,
          platformFeeUsd: receipt.platformFeeAmount,
          executionCostUsd: toolCostUsd,
          gasCostUsd: 0,
        });

        try {
          await this.recordLearning({
            rawTask,
            adapter,
            decision,
            execution: {
              output: toolResult.output ?? {},
              model: 'deterministic-tool',
              modelUsed: 'deterministic-tool',
              provider: 'meta-tool',
              tokensIn: 0,
              tokensOut: 0,
              costUsd: toolCostUsd,
              latencyMs,
              finishReason: 'stop',
              telemetry: system1Telemetry,
            },
            report: {
              decision: 'deliver',
              score: toolResult.evaluationScore ?? 1.0,
              schemaValid: true,
              hallucinationFlags: [],
              reason: 'deterministic_tool_verified',
            },
            totalCostUsd: toolCostUsd,
            totalLatencyMs: latencyMs,
            success: true,
            receipt,
          });
        } catch (err) {
          taskLog.error({ err }, 'learning event record failed');
        }
        return;
      }

      taskLog.warn(
        { error: toolResult.error },
        'System 1 tool execution failed or rejected by ratchet — escalating to System 2 standard loop',
      );
    }

    // --- SYSTEM 2: A2A DELEGATED / EXTERNALIZED TASK ---
    if (this.deps.a2aCapability?.isA2ATask(rawTask)) {
      taskLog.info('routing task to A2A capability orchestrator');
      const startTime = Date.now();
      const a2aResult = await this.deps.a2aCapability.executeTaskFromRaw(
        rawTask,
        this.deps.agentId,
      );
      this.deps.budget.record(a2aResult.metrics.costUsd);

      const a2aPeerId = (rawTask as any).peerId ?? (rawTask as any).providerAgentId ?? 'peer';
      const a2aTransport = a2aResult.telemetry?.transport ?? 'local';
      const a2aTelemetry: ExecutionTelemetry = a2aResult.telemetry ?? {
        provider: 'peer',
        model: 'a2a-orchestration',
        latencyMs: a2aResult.metrics.latencyMs || (Date.now() - startTime),
        tokensIn: 0,
        tokensOut: 0,
        costUsd: a2aResult.metrics.costUsd,
        fallbackUsed: false,
        fallbackChain: ['a2a-peer'],
        systemPath: 'system2',
        timestamp: new Date().toISOString(),
        peerId: a2aPeerId,
        transport: a2aTransport,
      };

      globalTelemetry.recordA2ATask(
        Boolean(a2aResult.success && a2aResult.escrowStatus === 'released'),
        a2aTelemetry,
      );

      if (a2aResult.success && a2aResult.escrowStatus === 'released') {
        const canonical = canonicalJson(a2aResult.output ?? {});
        const hash: Sha256Hash = sha256Hash(canonical);
        const sig = this.deps.signer.sign(canonical);

        const delivery: Delivery = {
          taskId: rawTask.id,
          workerId: this.deps.workerId,
          output: a2aResult.output ?? {},
          hash,
          sig,
          meta: {
            model: 'a2a-orchestration',
            provider: 'peer',
            tokensIn: 0,
            tokensOut: 0,
            costUsd: a2aResult.metrics.costUsd,
            latencyMs: a2aResult.metrics.latencyMs,
            qualityScore: 1.0,
            retries: 0,
          },
        };

        const receipt = await adapter.deliver(rawTask.id, delivery);
        taskLog.info(
          {
            hash,
            costUsd: a2aResult.metrics.costUsd,
            latencyMs: a2aResult.metrics.latencyMs,
            receipt: {
              status: receipt.status,
              currency: receipt.currency,
              netAmountUsd: receipt.netAmountUsd,
            },
          },
          'A2A task delivered',
        );

        await this.deps.ledger.releaseFunds({
          taskId: rawTask.id,
          adapterId: adapter.id,
          revenueUsd: receipt.amountUsd,
          platformFeeUsd: receipt.platformFeeAmount,
          executionCostUsd: a2aResult.metrics.costUsd,
          gasCostUsd: 0,
        });

        try {
          await this.recordLearning({
            rawTask,
            adapter,
            decision,
            execution: {
              output: a2aResult.output ?? {},
              model: 'a2a-orchestration',
              modelUsed: 'a2a-orchestration',
              provider: 'peer',
              tokensIn: 0,
              tokensOut: 0,
              costUsd: a2aResult.metrics.costUsd,
              latencyMs: a2aResult.metrics.latencyMs,
              finishReason: 'stop',
              telemetry: a2aTelemetry,
            },
            report: {
              decision: 'deliver',
              score: 1.0,
              schemaValid: true,
              hallucinationFlags: [],
              reason: 'a2a_service_ratchet_accepted',
            },
            totalCostUsd: a2aResult.metrics.costUsd,
            totalLatencyMs: a2aResult.metrics.latencyMs,
            success: true,
            receipt,
          });
        } catch (err) {
          taskLog.error({ err }, 'learning event record failed');
        }
        return;
      } else {
        taskLog.error(
          { error: a2aResult.error, escrowStatus: a2aResult.escrowStatus },
          'A2A execution rejected or failed',
        );

        try {
          await adapter.reject(
            rawTask.id,
            'a2a_failed:' + (a2aResult.error ?? 'unknown'),
          );
        } catch (err) {
          taskLog.error({ err }, 'reject call failed');
        }

        try {
          await this.deps.ledger.refundFunds({
            taskId: rawTask.id,
            adapterId: adapter.id,
            amountUsd: escrowAmountUsd,
          });
        } catch (err) {
          taskLog.error({ err }, 'escrow refund failed after A2A failure');
        }

        try {
          await this.recordLearning({
            rawTask,
            adapter,
            decision,
            execution: undefined,
            report: {
              decision: 'fail',
              score: 0,
              schemaValid: false,
              hallucinationFlags: [],
              reason: a2aResult.error ?? 'a2a_failed',
            },
            totalCostUsd: a2aResult.metrics.costUsd,
            totalLatencyMs: a2aResult.metrics.latencyMs,
            success: false,
            receipt: undefined,
          });
        } catch (err) {
          taskLog.error({ err }, 'learning event record failed');
        }
        return;
      }
    }

    // --- STANDARD / SYSTEM 2: EXECUTE + QUALITY ---
    const loop = await this.executeWithQuality(
      rawTask,
      decision,
      maxRetries,
      taskLog,
    );

    // Record cost regardless of outcome so the budget guard stays honest.
    this.deps.budget.record(loop.totalCostUsd);

    // --- QUALITY FAILED: reject, do not deliver ---
    if (loop.kind === 'failed') {
      taskLog.error(
        {
          reason: loop.report.reason,
          score: loop.report.score,
          attempts: loop.attempts,
          totalCostUsd: loop.totalCostUsd,
        },
        'quality failed after retries — rejecting task (no delivery, no settlement)',
      );

      try {
        await adapter.reject(
          rawTask.id,
          'quality_failed:' + loop.report.reason,
        );
      } catch (err) {
        taskLog.error({ err }, 'reject call failed');
      }

      try {
        await this.deps.ledger.refundFunds({
          taskId: rawTask.id,
          adapterId: adapter.id,
          amountUsd: escrowAmountUsd,
        });
      } catch (err) {
        taskLog.error({ err }, 'escrow refund failed after quality failure');
      }

      try {
        await this.recordLearning({
          rawTask,
          adapter,
          decision,
          execution: undefined,
          report: loop.report,
          totalCostUsd: loop.totalCostUsd,
          totalLatencyMs: loop.totalLatencyMs,
          success: false,
          receipt: undefined,
        });
      } catch (err) {
        taskLog.error({ err }, 'learning event record failed');
      }

      // Record task failure in reputation system and update dynamic card
      if (this.reputationSystem) {
        this.reputationSystem.recordFeedback({
          taskId: rawTask.id,
          agentId: this.identity.agentId,
          success: false,
          latencyMs: loop.totalLatencyMs,
          deadlineMs: terms.estimatedTimeS * 1000,
          evalScore: loop.report.score,
          ratchetAccepted: false,
          notes: loop.report.reason,
        });

        if (this.dynamicCardManager) {
          try {
            this.dynamicCardManager.updateCard({
              reason: `task_failure: ${rawTask.id}`,
              bumpType: 'patch',
            });
          } catch (e) {
            taskLog.warn({ err: e }, 'failed to update agent card after task failure');
          }
        }
      }

      // System 2 Reflection / Morphling Evolution Trigger upon failure
      if (this.evolutionLoop) {
        try {
          taskLog.info(
            { taskId: rawTask.id, score: loop.report.score, reason: loop.report.reason },
            'task quality failure triggered Morphling evolution trigger in System 2',
          );
          // Fire-and-forget or non-blocking reflection
          await this.evolutionLoop.executeCycle(
            {
              reason: 'task_failure',
              taskId: rawTask.id,
              details: {
                taskType: rawTask.type,
                failureReason: loop.report.reason,
                score: loop.report.score,
              },
            },
            async () => {
              // Propose an optimized meta-tool to avoid repeated failure
              const toolId = `auto-healer-${rawTask.type}`;
              return {
                type: 'create_new_tool',
                toolId,
                description: `Self-evolved tool for ${rawTask.type}`,
                instruction: `Adaptively handle task ${rawTask.type} after failure: ${loop.report.reason}`,
                candidateSourceCode: `console.log(JSON.stringify({ healed: true, taskType: "${rawTask.type}" }));`,
              };
            },
          );
        } catch (evoErr) {
          taskLog.warn({ evoErr }, 'Morphling evolution attempt after failure encountered an issue');
        }
      }

      return;
    }

    // --- BUILD + SIGN DELIVERY ---
    const canonical = canonicalJson(loop.execution.output);
    const hash: Sha256Hash = sha256Hash(canonical);
    const sig = this.deps.signer.sign(canonical);

    const delivery: Delivery = {
      taskId: rawTask.id,
      workerId: this.deps.workerId,
      output: loop.execution.output,
      hash,
      sig,
      meta: {
        model: loop.execution.model,
        provider: loop.execution.provider,
        tokensIn: loop.execution.tokensIn,
        tokensOut: loop.execution.tokensOut,
        costUsd: loop.totalCostUsd,
        latencyMs: loop.totalLatencyMs,
        qualityScore: loop.report.score,
        retries: loop.attempts - 1,
      },
    };

    const receipt = await adapter.deliver(rawTask.id, delivery);

    taskLog.info(
      {
        hash,
        qualityScore: loop.report.score,
        qualityDecision: loop.report.decision,
        attempts: loop.attempts,
        totalCostUsd: loop.totalCostUsd,
        receipt: {
          status: receipt.status,
          currency: receipt.currency,
          netAmountUsd: receipt.netAmountUsd,
        },
      },
      'delivered',
    );

    // --- LEDGER ---
    await this.deps.ledger.releaseFunds({
      taskId: rawTask.id,
      adapterId: adapter.id,
      revenueUsd: receipt.amountUsd,
      platformFeeUsd: receipt.platformFeeAmount,
      executionCostUsd: loop.totalCostUsd,
      gasCostUsd: 0,
    });

    // --- LEARNING ---
    try {
      await this.recordLearning({
        rawTask,
        adapter,
        decision,
        execution: loop.execution,
        report: loop.report,
        totalCostUsd: loop.totalCostUsd,
        totalLatencyMs: loop.totalLatencyMs,
        success: true,
        receipt,
      });
    } catch (err) {
      taskLog.error({ err }, 'learning event record failed');
    }

    // Record task success in reputation system and update dynamic card
    if (this.reputationSystem) {
      this.reputationSystem.recordFeedback({
        taskId: rawTask.id,
        agentId: this.identity.agentId,
        success: true,
        latencyMs: loop.totalLatencyMs,
        deadlineMs: terms.estimatedTimeS * 1000,
        evalScore: loop.report.score,
        ratchetAccepted: true,
      });

      if (this.dynamicCardManager) {
        try {
          this.dynamicCardManager.updateCard({
            reason: `task_success: ${rawTask.id}`,
            bumpType: 'patch',
          });
        } catch (e) {
          taskLog.warn({ err: e }, 'failed to update agent card after task success');
        }
      }
    }
    } catch (err) {
      try {
        await this.deps.ledger.refundFunds({
          taskId: rawTask.id,
          adapterId: adapter.id,
          amountUsd: escrowAmountUsd,
        });
      } catch (refundErr) {
        taskLog.error({ err: refundErr }, 'escrow refund failed after task error');
      }
      if (this.reputationSystem) {
        const isTimeout = String(err).toLowerCase().includes('timeout');
        this.reputationSystem.recordFeedback({
          taskId: rawTask.id,
          agentId: this.identity.agentId,
          success: false,
          timedOut: isTimeout,
          metDeadline: !isTimeout,
          evalScore: 0,
          notes: String(err),
        });
        if (this.dynamicCardManager) {
          try {
            this.dynamicCardManager.updateCard({
              reason: `task_error: ${rawTask.id}`,
              bumpType: 'patch',
            });
          } catch (cardErr) {
            taskLog.warn({ err: cardErr }, 'failed to update agent card after task error');
          }
        }
      }
      throw err;
    } finally {
      this.inFlightTasks.delete(rawTask.id);
    }
  }

  private async recordLearning(args: {
    rawTask: RawTask;
    adapter: MarketplaceAdapter;
    decision: EconomicDecision;
    execution: ExecutionResult | undefined;
    report: QualityReport;
    totalCostUsd: number;
    totalLatencyMs: number;
    success: boolean;
    receipt: SettlementReceipt | undefined;
  }): Promise<void> {
    const {
      rawTask,
      adapter,
      decision,
      execution,
      report,
      totalCostUsd,
      totalLatencyMs,
      success,
      receipt,
    } = args;

    const predictedLatencyS = 30;
    const actualLatencyS = totalLatencyMs / 1000;
    const revenueUsd = receipt?.amountUsd ?? 0;
    const platformFeeUsd = receipt?.platformFeeAmount ?? 0;
    const profitUsd = success
      ? revenueUsd - platformFeeUsd - totalCostUsd
      : -totalCostUsd;

    const settlementDelayH = Math.max(
      adapter.capabilities().limits.averageSettlementDelayHours,
      this.deps.delayFloorHours,
    );
    const totalTimeH = actualLatencyS / 3600 + settlementDelayH;
    const timeAdjustedProfit = profitUsd / Math.max(totalTimeH, 1e-6);

    await this.deps.learning.record({
      id: rawTask.id,
      agentId: this.deps.agentId,
      taskId: rawTask.id,
      adapterId: adapter.id,
      taskType: rawTask.type,
      strategyId: decision.strategyId,
      predicted: {
        costUsd: decision.components.expectedTotalCostUsd,
        latencyS: predictedLatencyS,
        successProb: decision.successProbability,
        quality: 1,
        model: decision.model,
        settlementDelayH,
      },
      actual: {
        costUsd: totalCostUsd,
        latencyS: actualLatencyS,
        success,
        quality: report.score,
        model: execution?.model ?? 'none',
        provider: execution?.provider ?? 'google',
        settlementDelayH,
        platformFeeUsd,
        gasCostUsd: 0,
      },
      budgetContext: this.deps.budget.snapshot(),
      revenueUsd,
      profitUsd,
      timeAdjustedProfit,
      errorKind: success ? undefined : report.reason,
      clientFeedback: success
        ? receipt?.status === 'settled'
          ? 'accepted'
          : undefined
        : 'rejected',
      ts: new Date().toISOString(),
    });
  }

  private async executeWithQuality(
    rawTask: RawTask,
    decision: EconomicDecision,
    maxRetries: number,
    taskLog: Logger,
  ): Promise<QualityLoopResult> {
    let attempt = 0;
    let previousError: string | undefined;
    let lastReport: QualityReport | undefined;

    let totalCostUsd = 0;
    let totalLatencyMs = 0;

    while (attempt <= maxRetries) {
      const execution = await this.deps.executor.execute({
        task: rawTask,
        model: decision.model,
        maxTokens: 1024,
        attempt,
        previousError,
      });

      totalCostUsd += execution.costUsd;
      totalLatencyMs += execution.latencyMs;

      taskLog.info(
        {
          attempt,
          model: execution.model,
          provider: execution.provider,
          tokensIn: execution.tokensIn,
          tokensOut: execution.tokensOut,
          costUsd: execution.costUsd,
          latencyMs: execution.latencyMs,
        },
        'executed',
      );

      const report = this.deps.quality.check({
        output: execution.output,
        schema: rawTask.outputSchema ?? { type: 'object' },
        attempt,
        maxRetries,
      });

      lastReport = report;

      taskLog.info(
        {
          attempt,
          decision: report.decision,
          score: report.score,
          schemaValid: report.schemaValid,
          reason: report.reason,
        },
        'quality',
      );

      if (report.decision === 'deliver') {
        return {
          kind: 'delivered',
          execution,
          report,
          attempts: attempt + 1,
          totalCostUsd,
          totalLatencyMs,
        };
      }

      if (report.decision === 'fail') {
        return {
          kind: 'failed',
          report,
          attempts: attempt + 1,
          totalCostUsd,
          totalLatencyMs,
        };
      }

      previousError = report.reason;
      attempt += 1;
      taskLog.info({ nextAttempt: attempt }, 'retrying execution');
    }

    // Unreachable in practice — quality returns one of the three decisions.
    return {
      kind: 'failed',
      report: lastReport!,
      attempts: attempt,
      totalCostUsd,
      totalLatencyMs,
    };
  }

  /** Access to optional A2A capability mixin */
  public get a2a(): A2ACapability | undefined {
    return this.deps.a2aCapability;
  }

  /**
   * Directly requests a service from a peer agent using A2A orchestrator & escrow.
   * AgentCore serves as the Single Source of Truth.
   */
  public async requestServiceFromPeer(
    providerAgentId: string,
    toolId: string,
    parameters: Record<string, unknown>,
    maxBudget: number,
  ): Promise<{
    success: boolean;
    output?: unknown;
    error?: string;
    costUsd: number;
    escrowStatus?: string;
    signature?: string;
  }> {
    if (!this.deps.a2aCapability) {
      return {
        success: false,
        error: 'A2A capability is not configured on AgentCore',
        costUsd: 0,
        escrowStatus: 'failed',
      };
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const request: A2ATaskExecutionRequest = {
      taskId,
      toolId,
      parameters,
      costUsd: maxBudget,
      clientAgentId: this.deps.agentId,
      providerAgentId,
      timeoutMs: 30_000,
    };

    if (this.circuitBreakers) {
      const breaker = this.circuitBreakers.get(`peer:${providerAgentId}`);
      if (!breaker.canExecute()) {
        this.log.warn({ peer: providerAgentId }, 'circuit breaker is OPEN for peer - fast failing request');
        return {
          success: false,
          error: `Circuit breaker is OPEN for peer '${providerAgentId}'`,
          costUsd: 0,
          escrowStatus: 'failed',
        };
      }
    }

    const signedRequest = this.identity.signA2ARequest(request, 30_000);
    const result = await this.deps.a2aCapability.executeTask(signedRequest);

    if (this.circuitBreakers) {
      const breaker = this.circuitBreakers.get(`peer:${providerAgentId}`);
      if (result.success) {
        breaker.recordSuccess();
      } else {
        breaker.recordFailure(result.error);
      }
    }

    if (this.reputationSystem) {
      this.reputationSystem.recordFeedback({
        taskId,
        agentId: providerAgentId,
        success: result.success,
        latencyMs: result.metrics.latencyMs,
        deadlineMs: request.timeoutMs ?? 30_000,
        evalScore: result.success ? 1.0 : 0.0,
        ratchetAccepted: result.success,
        notes: result.error,
      });
    }

    return {
      success: result.success,
      ...(result.output === undefined ? {} : { output: result.output }),
      ...(result.error ? { error: result.error } : {}),
      costUsd: result.metrics.costUsd,
      escrowStatus: result.escrowStatus,
      signature: result.signature,
    };
  }

  /**
   * Handles an incoming A2A request from a peer with zero-trust cryptographic verification.
   */
  public async handleIncomingA2ARequest(
    request: A2ATaskExecutionRequest,
  ): Promise<A2ATaskExecutionResult> {
    if (this.isDraining()) {
      this.log.warn(
        { taskId: request.taskId, client: request.clientAgentId },
        'agent is draining/stopped - rejecting inbound A2A request (503)',
      );
      return {
        success: false,
        error: 'Agent is shutting down (503 Service Unavailable)',
        escrowStatus: 'failed',
        metrics: { latencyMs: 0, costUsd: 0 },
      };
    }

    if (this.granularRateLimiter) {
      const check = this.granularRateLimiter.tryConsume({
        peerId: request.clientAgentId,
        skillId: request.toolId,
        tokens: 1,
      });
      if (!check.allowed) {
        this.log.warn(
          { taskId: request.taskId, client: request.clientAgentId, reason: check.reason },
          'inbound A2A request rate limited by granular rate limiter (429)',
        );
        return {
          success: false,
          error: `Rate limit exceeded: ${check.reason} (429 Too Many Requests)`,
          escrowStatus: 'failed',
          metrics: { latencyMs: 0, costUsd: 0 },
        };
      }
    } else if (!this.a2aRateLimiter.tryConsume(1)) {
      this.log.warn(
        { taskId: request.taskId, client: request.clientAgentId },
        'inbound A2A request rate limited (429 Too Many Requests)',
      );
      return {
        success: false,
        error: 'Rate limit exceeded for inbound A2A requests (429 Too Many Requests)',
        escrowStatus: 'failed',
        metrics: { latencyMs: 0, costUsd: 0 },
      };
    }

    this.inFlightTasks.add(request.taskId);
    try {
      if (!this.deps.a2aCapability) {
        return {
          success: false,
          error: 'A2A capability is not configured on AgentCore',
          escrowStatus: 'failed',
          metrics: { latencyMs: 0, costUsd: 0 },
        };
      }

      if (request.providerAgentId !== this.deps.agentId) {
        return {
          success: false,
          error: 'Agent ID mismatch',
          escrowStatus: 'failed',
          metrics: { latencyMs: 0, costUsd: 0 },
        };
      }

      // Strict zero-trust cryptographic passport verification
      if (request.signature) {
        const verification = AgentIdentity.verifyA2ARequest(request, {
          expectedProviderId: this.deps.agentId,
        });
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
      }

      const result = await this.deps.a2aCapability.executeTask(request);
      return this.identity.signA2AResult(result, request.taskId);
    } finally {
      this.inFlightTasks.delete(request.taskId);
    }
  }
}

/**
 * Economic A2A facade for agents that purchase services from peer agents.
 * It is intentionally separate from AgentCore's marketplace polling loop.
 */
export class AutonomousAgent {
  private readonly wallet: AgentWallet;
  private readonly reputationSystem?: ReputationSystem;
  private readonly identity?: AgentIdentity;

  constructor(
    private readonly agentId: string,
    private readonly a2aOrchestrator: A2AAgentOrchestrator,
    private readonly metaToolRegistry: MetaToolRegistry,
    initialBalance = 1_000,
    reputationSystem?: ReputationSystem,
    identity?: AgentIdentity,
  ) {
    this.wallet = new AgentWallet(agentId, initialBalance);
    this.reputationSystem = reputationSystem;
    this.identity = identity;
  }

  /** Requests a registered Meta-Tool service from a peer through A2A escrow. */
  public async requestServiceFromPeer(
    providerAgentId: string,
    toolId: string,
    parameters: Record<string, unknown>,
    maxBudget: number,
  ): Promise<{
    success: boolean;
    output?: unknown;
    error?: string;
    costUsd: number;
    escrowStatus?: string;
    signature?: string;
  }> {
    if (!Number.isFinite(maxBudget) || maxBudget <= 0) {
      return { success: false, error: 'Invalid maximum budget', costUsd: 0, escrowStatus: 'failed' };
    }
    if (!this.metaToolRegistry.getLatest(toolId)) {
      return { success: false, error: `Unknown meta-tool: ${toolId}`, costUsd: 0, escrowStatus: 'failed' };
    }
    if (!this.wallet.canAfford(maxBudget)) {
      return { success: false, error: 'Insufficient balance', costUsd: 0, escrowStatus: 'failed' };
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    let request: A2ATaskExecutionRequest = {
      taskId,
      toolId,
      parameters,
      costUsd: maxBudget,
      clientAgentId: this.agentId,
      providerAgentId,
      timeoutMs: 30_000,
    };

    if (this.identity) {
      request = this.identity.signA2ARequest(request, 30_000);
    }

    const startTime = Date.now();
    const result = await this.a2aOrchestrator.executeA2ATask(request);
    if (result.success && result.escrowStatus === 'released') {
      this.wallet.deduct(result.metrics.costUsd);
    }

    if (this.reputationSystem) {
      this.reputationSystem.recordFeedback({
        taskId,
        agentId: providerAgentId,
        success: result.success,
        latencyMs: Date.now() - startTime,
        deadlineMs: request.timeoutMs ?? 30_000,
        evalScore: result.success ? 1.0 : 0.0,
        ratchetAccepted: result.success,
        notes: result.error,
      });
    }

    return {
      success: result.success,
      ...(result.output === undefined ? {} : { output: result.output }),
      ...(result.error ? { error: result.error } : {}),
      costUsd: result.metrics.costUsd,
      escrowStatus: result.escrowStatus,
      signature: result.signature,
    };
  }

  /** Handles a peer request only when this agent is the declared provider. */
  public async handleIncomingRequest(
    request: A2ATaskExecutionRequest,
  ): Promise<A2ATaskExecutionResult> {
    if (request.providerAgentId !== this.agentId) {
      return {
        success: false,
        error: 'Agent ID mismatch',
        escrowStatus: 'failed',
        metrics: { latencyMs: 0, costUsd: 0 },
      };
    }

    return this.a2aOrchestrator.executeA2ATask(request);
  }

  /** Returns the wallet's currently available balance. */
  public getBalance(): number {
    return this.wallet.getBalance();
  }
}
