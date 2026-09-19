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
import { canonicalJson, sha256Hash } from '../identity/ed25519.js';
import { createLogger, type Logger } from '../observability/logger.js';

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

  constructor(private readonly deps: AgentCoreDeps) {}

  async run(): Promise<void> {
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

  async stop(): Promise<void> {
    this.stopped = true;
    await this.deps.registry.stopAll();
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

    // --- EXECUTE + QUALITY ---
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
    try {
      await this.deps.ledger.recordSettlement({
        taskId: rawTask.id,
        adapterId: adapter.id,
        revenueUsd: receipt.amountUsd,
        platformFeeUsd: receipt.platformFeeAmount,
        executionCostUsd: loop.totalCostUsd,
        gasCostUsd: 0,
      });
    } catch (err) {
      taskLog.error({ err }, 'ledger settlement failed');
    }

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
}
