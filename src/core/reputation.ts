/**
 * Reputation System for Autonomous Agents & Peers.
 *
 * Computes and tracks a weighted reputation score (between 0.0 and 1.0) for the
 * local agent and known peer agents based on:
 *   1. Delivery success rate (weight: 40%)
 *   2. Deadline adherence / timeliness (weight: 25%)
 *   3. EvalPack quality & verification score (weight: 20%)
 *   4. Evolution & Ratchet history acceptance (weight: 15%)
 */

import { createLogger } from '../observability/logger.js';
import type { EvalReport } from './eval-pack.js';

export interface TaskCompletionFeedback {
  taskId: string;
  agentId?: string;
  success: boolean;
  metDeadline?: boolean;
  timedOut?: boolean;
  latencyMs?: number;
  deadlineMs?: number;
  evalReport?: EvalReport;
  evalScore?: number;
  ratchetAccepted?: boolean;
  evolutionAccepted?: boolean;
  notes?: string;
  timestamp?: string;
}

export interface ReputationHistoryEntry {
  timestamp: string;
  scoreAfter: number;
  success: boolean;
  taskId: string;
  timedOut?: boolean;
  evalScore?: number;
  ratchetAccepted?: boolean;
  notes?: string;
}

export interface AgentReputationRecord {
  agentId: string;
  reputationScore: number;
  totalTasks: number;
  successfulTasks: number;
  failedTasks: number;
  onTimeDeliveries: number;
  lateDeliveries: number;
  timedOutDeliveries: number;
  averageEvalScore: number;
  ratchetAcceptedCount: number;
  ratchetRejectedCount: number;
  evolutionAcceptedCount: number;
  lastUpdated: string;
  history: ReputationHistoryEntry[];
}

export type ReputationUpdateListener = (
  agentId: string,
  newScore: number,
  record: AgentReputationRecord,
  feedback: TaskCompletionFeedback,
) => void;

export interface ReputationWeights {
  deliverySuccessWeight: number; // default: 0.40
  deadlineAdherenceWeight: number; // default: 0.25
  evalScoreWeight: number; // default: 0.20
  evolutionAcceptanceWeight: number; // default: 0.15
}

export const DEFAULT_REPUTATION_WEIGHTS: ReputationWeights = {
  deliverySuccessWeight: 0.40,
  deadlineAdherenceWeight: 0.25,
  evalScoreWeight: 0.20,
  evolutionAcceptanceWeight: 0.15,
};

export class ReputationSystem {
  private readonly log = createLogger('reputation');
  private readonly agentScores = new Map<string, AgentReputationRecord>();
  private readonly weights: ReputationWeights;
  private readonly maxHistoryPerAgent: number;
  private readonly listeners = new Set<ReputationUpdateListener>();

  constructor(options?: {
    weights?: Partial<ReputationWeights>;
    maxHistoryPerAgent?: number;
  }) {
    this.weights = {
      ...DEFAULT_REPUTATION_WEIGHTS,
      ...(options?.weights ?? {}),
    };
    this.maxHistoryPerAgent = options?.maxHistoryPerAgent ?? 50;
  }

  /**
   * Registers a listener that gets invoked whenever an agent's reputation score updates.
   * Returns an unsubscribe function.
   */
  public onUpdate(listener: ReputationUpdateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Returns score history for an agent.
   */
  public getHistory(agentId: string): ReputationHistoryEntry[] {
    return [...(this.agentScores.get(agentId)?.history ?? [])];
  }

  /**
   * Initializes or gets the existing reputation record for an agent.
   */
  public getOrCreateRecord(agentId: string): AgentReputationRecord {
    let record = this.agentScores.get(agentId);
    if (!record) {
      record = {
        agentId,
        reputationScore: 1.0, // Initial optimistic trust baseline
        totalTasks: 0,
        successfulTasks: 0,
        failedTasks: 0,
        onTimeDeliveries: 0,
        lateDeliveries: 0,
        timedOutDeliveries: 0,
        averageEvalScore: 1.0,
        ratchetAcceptedCount: 0,
        ratchetRejectedCount: 0,
        evolutionAcceptedCount: 0,
        lastUpdated: new Date().toISOString(),
        history: [],
      };
      this.agentScores.set(agentId, record);
    }
    return record;
  }

  /**
   * Returns current reputation score for an agent (clamped [0.0, 1.0]).
   */
  public getScore(agentId: string): number {
    const record = this.agentScores.get(agentId);
    return record ? record.reputationScore : 1.0;
  }

  /**
   * Returns full record for an agent.
   */
  public getRecord(agentId: string): AgentReputationRecord | undefined {
    return this.agentScores.get(agentId);
  }

  /**
   * Returns a calculated summary of an agent's reputation metrics.
   */
  public getSummary(agentId: string): {
    agentId: string;
    reputationScore: number;
    totalDeliveries: number;
    successfulDeliveries: number;
    failedDeliveries: number;
    deadlineAdherenceRatio: number;
    timedOutDeliveries: number;
    averageEvalScore: number;
    historyLength: number;
  } {
    const record = this.getOrCreateRecord(agentId);
    const deadlineTotal = record.onTimeDeliveries + record.lateDeliveries;
    const deadlineRatio = deadlineTotal > 0 ? record.onTimeDeliveries / deadlineTotal : 1.0;

    return {
      agentId,
      reputationScore: record.reputationScore,
      totalDeliveries: record.totalTasks,
      successfulDeliveries: record.successfulTasks,
      failedDeliveries: record.failedTasks,
      deadlineAdherenceRatio: deadlineRatio,
      timedOutDeliveries: record.timedOutDeliveries,
      averageEvalScore: record.averageEvalScore,
      historyLength: record.history.length,
    };
  }

  /**
   * Records task feedback and recalculates the weighted reputation score.
   */
  public recordFeedback(feedback: TaskCompletionFeedback): {
    score: number;
    record: AgentReputationRecord;
  } {
    const agentId = feedback.agentId ?? 'self';
    const record = this.getOrCreateRecord(agentId);

    record.totalTasks++;
    if (feedback.success) {
      record.successfulTasks++;
    } else {
      record.failedTasks++;
    }

    // Handle timeout
    if (feedback.timedOut) {
      record.timedOutDeliveries = (record.timedOutDeliveries || 0) + 1;
      record.lateDeliveries++;
    } else if (feedback.metDeadline !== undefined) {
      if (feedback.metDeadline) {
        record.onTimeDeliveries++;
      } else {
        record.lateDeliveries++;
      }
    } else if (feedback.deadlineMs !== undefined && feedback.latencyMs !== undefined) {
      if (feedback.latencyMs <= feedback.deadlineMs) {
        record.onTimeDeliveries++;
      } else {
        record.lateDeliveries++;
      }
    } else {
      // Default assume on-time if successful
      if (feedback.success) {
        record.onTimeDeliveries++;
      }
    }

    // EvalPack score
    const taskEvalScore =
      feedback.evalReport?.score ??
      feedback.evalScore ??
      (feedback.success ? 1.0 : 0.0);

    // Cumulative moving average of eval score
    record.averageEvalScore =
      (record.averageEvalScore * (record.totalTasks - 1) + taskEvalScore) / record.totalTasks;

    // Ratchet / Evolution history
    if (feedback.ratchetAccepted !== undefined) {
      if (feedback.ratchetAccepted) {
        record.ratchetAcceptedCount++;
      } else {
        record.ratchetRejectedCount++;
      }
    }

    if (feedback.evolutionAccepted) {
      record.evolutionAcceptedCount++;
    }

    // Compute composite weighted score
    const newScore = this.calculateWeightedScore(record);
    record.reputationScore = parseFloat(newScore.toFixed(3));
    record.lastUpdated = new Date().toISOString();

    record.history.unshift({
      timestamp: record.lastUpdated,
      scoreAfter: record.reputationScore,
      success: feedback.success,
      taskId: feedback.taskId,
      timedOut: feedback.timedOut,
      evalScore: taskEvalScore,
      ratchetAccepted: feedback.ratchetAccepted,
      notes: feedback.notes,
    });

    if (record.history.length > this.maxHistoryPerAgent) {
      record.history.pop();
    }

    this.log.info(
      {
        agentId,
        score: record.reputationScore,
        totalTasks: record.totalTasks,
        success: feedback.success,
        taskId: feedback.taskId,
      },
      'reputation score updated',
    );

    // Notify registered listeners
    for (const listener of this.listeners) {
      try {
        listener(agentId, record.reputationScore, record, feedback);
      } catch (err) {
        this.log.error({ err, agentId }, 'reputation update listener failed');
      }
    }

    return { score: record.reputationScore, record };
  }

  /**
   * Calculates the composite reputation score based on configured weights:
   * 1. Delivery success rate (successfulTasks / totalTasks)
   * 2. Deadline adherence (onTimeDeliveries / (onTimeDeliveries + lateDeliveries))
   * 3. EvalPack quality average (averageEvalScore)
   * 4. Ratchet / evolution health ((accepted / (accepted + rejected)))
   */
  private calculateWeightedScore(record: AgentReputationRecord): number {
    if (record.totalTasks === 0) {
      return 1.0;
    }

    // 1. Success rate (0.0 to 1.0)
    const successRate = record.successfulTasks / record.totalTasks;

    // 2. Deadline adherence (0.0 to 1.0)
    const deadlineTotal = record.onTimeDeliveries + record.lateDeliveries;
    const deadlineRate = deadlineTotal > 0 ? record.onTimeDeliveries / deadlineTotal : 1.0;

    // 3. EvalPack score (0.0 to 1.0)
    const evalScore = Math.max(0, Math.min(1, record.averageEvalScore));

    // 4. Evolution / Ratchet health (0.0 to 1.0)
    const ratchetTotal = record.ratchetAcceptedCount + record.ratchetRejectedCount;
    const ratchetRate = ratchetTotal > 0 ? record.ratchetAcceptedCount / ratchetTotal : 1.0;

    const weighted =
      successRate * this.weights.deliverySuccessWeight +
      deadlineRate * this.weights.deadlineAdherenceWeight +
      evalScore * this.weights.evalScoreWeight +
      ratchetRate * this.weights.evolutionAcceptanceWeight;

    // Clamp score strictly between 0.0 and 1.0
    return Math.max(0.0, Math.min(1.0, weighted));
  }

  /**
   * Resets all reputation tracking data (useful for test isolation).
   */
  public reset(): void {
    this.agentScores.clear();
  }

  /**
   * Exports full reputation state for persistent storage.
   */
  public exportState(): Record<string, AgentReputationRecord> {
    const exported: Record<string, AgentReputationRecord> = {};
    for (const [id, rec] of this.agentScores.entries()) {
      exported[id] = { ...rec, history: [...rec.history] };
    }
    return exported;
  }

  /**
   * Imports previously persisted reputation state.
   */
  public importState(data: Record<string, AgentReputationRecord>): void {
    if (!data || typeof data !== 'object') return;
    for (const [id, rec] of Object.entries(data)) {
      if (rec && typeof rec === 'object') {
        this.agentScores.set(id, {
          ...rec,
          history: Array.isArray(rec.history) ? [...rec.history] : [],
        });
      }
    }
  }
}
