import { EconomicTracker } from '../economic/tracker.js';
import { BiddingEngine } from '../economic/bidding.js';
/**
 * Autonomous Agent Core Engine Daemon.
 *
 * Implements the continuous A2A/M2M operational loop:
 *   1. Adapter Initialization & Task Ingestion (OKX Web3)
 *   2. Economic Triage & Expected Value Gate (triage.ts & cost-estimator.ts)
 *   3. LLM Execution (executor.ts)
 *   4. Quality Evaluation & Schema Verification (evaluation/quality.ts)
 *   5. Ed25519 Canonical Signing & Settlement Submission
 */

import type { MarketplaceAdapter, Task, TaskArtifact } from '../../adapters/interface.js';
import { OKXMarketplaceAdapter } from '../../adapters/marketplaces/okx/index.js';
import { canonicalJson, type Signer } from '../../identity/ed25519.js';
import { shouldAcceptTask, TaskRejectedError } from '../economics/triage.js';
import { estimateCostFromPromptText } from '../economics/cost-estimator.js';
import { EngineExecutor } from './executor.js';
import { QualityEvaluator } from '../evaluation/quality.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('agent-engine');

export interface AgentEngineConfig {
  signer: Signer;
  adapters?: MarketplaceAdapter[];
  executor?: EngineExecutor;
  qualityEvaluator?: QualityEvaluator;
  pollIntervalMs?: number;
  model?: string;
  defaultSuccessProbability?: number;
}

export class AgentEngine {
  public getEconomicTracker(): EconomicTracker {
    return this.tracker;
  }
  public getBiddingEngine(): BiddingEngine {
    return this.biddingEngine;
  }

  private tracker = new EconomicTracker();
  private biddingEngine = new BiddingEngine(this.tracker);

  private readonly signer: Signer;
  private readonly adapters: Map<string, MarketplaceAdapter> = new Map();
  private readonly executor: EngineExecutor;
  private readonly quality: QualityEvaluator;
  private readonly pollIntervalMs: number;
  private readonly model: string;
  private readonly defaultSuccessProbability: number;
  private running = false;
  private loopPromise?: Promise<void>;

  constructor(config: AgentEngineConfig) {
    this.signer = config.signer;
    this.executor = config.executor ?? new EngineExecutor();
    this.quality = config.qualityEvaluator ?? new QualityEvaluator(0.7);
    this.pollIntervalMs = config.pollIntervalMs ?? 5000;
    this.model = config.model ?? 'gemini-1.5-flash';
    this.defaultSuccessProbability = config.defaultSuccessProbability ?? 0.85;

    // 1. Initialize Adapters (OKX default if none provided)
    if (config.adapters && config.adapters.length > 0) {
      for (const adapter of config.adapters) {
        this.registerAdapter(adapter);
      }
    } else {
      const okxAdapter = new OKXMarketplaceAdapter(this.signer);
      this.registerAdapter(okxAdapter);
    }
  }

  /**
   * Registers a marketplace adapter into the active polling registry.
   */
  public registerAdapter(adapter: MarketplaceAdapter): void {
    this.adapters.set(adapter.id, adapter);
    log.info({ adapterId: adapter.id }, 'Marketplace adapter registered');
  }

  /**
   * Starts the autonomous daemon loop.
   */
  public async start(): Promise<void> {
    if (this.running) {
      log.warn('AgentEngine daemon is already running');
      return;
    }

    this.running = true;
    log.info(
      {
        adapters: Array.from(this.adapters.keys()),
        pollIntervalMs: this.pollIntervalMs,
        model: this.model,
      },
      'Starting Autonomous Agent Core Loop',
    );

    this.loopPromise = this.runLoop();
  }

  /**
   * Gracefully stops the autonomous daemon loop.
   */
  public async stop(): Promise<void> {
    if (!this.running) return;

    log.info('Stopping Autonomous Agent Core Loop...');
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise;
    }
    log.info('Autonomous Agent Core Loop stopped');
  }

  /**
   * Continuous daemon polling loop with resilient error containment.
   */
  private async runLoop(): Promise<void> {
    while (this.running) {
      for (const [id, adapter] of this.adapters.entries()) {
        if (!this.running) break;

        try {
          // 2. Poll for available marketplace tasks
          const tasks = await adapter.pollTasks();
          if (tasks.length > 0) {
            log.info({ adapterId: id, taskCount: tasks.length }, 'Discovered marketplace tasks');
          }

          for (const task of tasks) {
            if (!this.running) break;
            await this.processTask(adapter, task);
          }
        } catch (err) {
          // Error in polling single adapter must not crash daemon
          log.error({ adapterId: id, err }, 'Error during adapter polling cycle');
        }
      }

      // Delay before next polling interval
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * End-to-end task execution pipeline:
   *   Triage -> LLM Execution -> Quality Check -> Signing & Settlement
   */
  public async processTask(adapter: MarketplaceAdapter, task: Task): Promise<boolean> {
    log.info(
      {
        taskId: task.id,
        marketplace: task.marketplace,
        reward: task.reward,
        currency: task.currency,
      },
      'Processing inbound task',
    );

    try {
      // 3. Economic Triage: Cost estimation & Expected Value evaluation
      const estimatedCost = estimateCostFromPromptText(task.prompt, this.model);
      const successProbability = this.defaultSuccessProbability;

      try {
        const triageDecision = shouldAcceptTask(
          task.reward,
          successProbability,
          estimatedCost,
          { currency: task.currency },
        );

        log.info(
          {
            taskId: task.id,
            ev: triageDecision.ev,
            margin: triageDecision.netMargin,
            estimatedCost,
          },
          'Task passed economic triage: ACCEPTED',
        );
      } catch (triageErr) {
        if (triageErr instanceof TaskRejectedError) {
          log.warn(
            {
              taskId: task.id,
              reason: triageErr.reason,
              ev: triageErr.ev,
              reward: task.reward,
              estimatedCost,
            },
            'Task failed economic triage: REJECTED',
          );
          return false;
        }
        throw triageErr;
      }

      // 4. LLM Execution via EngineExecutor
      log.info({ taskId: task.id, model: this.model }, 'Dispatching to LLM executor');
      const executionResult = await this.executor.execute(task.prompt, this.model);

      // 5. Quality Evaluation
      const qualityReport = this.quality.evaluate({
        output: executionResult.content,
        prompt: task.prompt,
      });

      if (!qualityReport.passed) {
        log.warn(
          { taskId: task.id, score: qualityReport.score, reason: qualityReport.reason },
          'Quality evaluation failed - task discarded',
        );
        return false;
      }

      // 6. Build and Cryptographically Sign Artifact with Ed25519
      const artifact: TaskArtifact = {
        content: executionResult.content,
        model: executionResult.model,
        completedAt: executionResult.completedAt,
        metadata: {
          tokensIn: executionResult.tokensIn,
          tokensOut: executionResult.tokensOut,
          latencyMs: executionResult.latencyMs,
          qualityScore: qualityReport.score,
        },
      };

      // Canonical serialization + Ed25519 signature
      const canonicalPayload = canonicalJson(artifact);
      const signature = this.signer.sign(canonicalPayload);

      // Submit artifact and receipt to marketplace adapter
      const receipt = await adapter.submitArtifact(task.id, artifact, signature);

      if (receipt.success) {
        log.info(
          {
            taskId: task.id,
            settlementId: receipt.settlementId,
            submittedAt: receipt.submittedAt,
          },
          'Task successfully fulfilled and settled on marketplace',
        );
        return true;
      } else {
        log.error(
          { taskId: task.id, error: receipt.error },
          'Marketplace rejected artifact submission',
        );
        return false;
      }
    } catch (taskErr) {
      log.error({ taskId: task.id, err: taskErr }, 'Unexpected error processing task');
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
