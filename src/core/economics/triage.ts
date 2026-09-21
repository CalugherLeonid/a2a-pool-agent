/**
 * Economic Triage Engine for Autonomous Task Acceptance.
 *
 * Implements Expected Value (EV) calculation:
 *   EV = (taskReward * successProbability) - estimatedCost
 *
 * Tasks are strictly rejected if:
 *   - successProbability < 0.70
 *   - EV <= 0 (negative or zero expected economic return)
 */

export interface TriageDecision {
  accepted: true;
  ev: number;
  taskReward: number;
  successProbability: number;
  estimatedCost: number;
  netMargin: number;
  currency: string;
}

export interface TaskRejectionDetails {
  reason: 'PROBABILITY_TOO_LOW' | 'NEGATIVE_EXPECTED_VALUE';
  ev: number;
  taskReward: number;
  successProbability: number;
  estimatedCost: number;
  currency: string;
}

/**
 * Custom error thrown when a task fails the autonomous economic triage criteria.
 */
export class TaskRejectedError extends Error {
  public readonly reason: 'PROBABILITY_TOO_LOW' | 'NEGATIVE_EXPECTED_VALUE';
  public readonly ev: number;
  public readonly taskReward: number;
  public readonly successProbability: number;
  public readonly estimatedCost: number;
  public readonly currency: string;

  constructor(message: string, details: TaskRejectionDetails) {
    super(message);
    this.name = 'TaskRejectedError';
    this.reason = details.reason;
    this.ev = details.ev;
    this.taskReward = details.taskReward;
    this.successProbability = details.successProbability;
    this.estimatedCost = details.estimatedCost;
    this.currency = details.currency;

    // Maintain standard stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TaskRejectedError);
    }
  }
}

export interface ShouldAcceptOptions {
  currency?: string;
  minSuccessProbability?: number;
  minProfitFloorUsd?: number;
}

/**
 * Evaluates whether a task should be accepted based on financial Expected Value (EV).
 *
 * Formula:
 *   EV = (taskReward * successProbability) - estimatedCost
 *
 * @param taskReward Compensation offered by the marketplace (in USD/USDT).
 * @param successProbability Estimated likelihood of delivering an acceptable artifact (0.0 to 1.0).
 * @param estimatedCost Projected inference and execution cost (in USD/USDT).
 * @param options Optional custom bounds.
 * @throws {TaskRejectedError} If successProbability < 0.7 or EV <= 0.
 * @returns TriageDecision confirming acceptance and economic metrics.
 */
export function shouldAcceptTask(
  taskReward: number,
  successProbability: number,
  estimatedCost: number,
  options?: ShouldAcceptOptions,
): TriageDecision {
  const currency = options?.currency ?? 'USD';
  const minSuccess = options?.minSuccessProbability ?? 0.7;
  const minProfitFloor = options?.minProfitFloorUsd ?? 0.0;

  // 1. Success Probability Filter (hard floor: 0.70)
  if (successProbability < minSuccess) {
    const rawEv = Number((taskReward * successProbability - estimatedCost).toFixed(6));
    throw new TaskRejectedError(
      `Task rejected: success probability ${(successProbability * 100).toFixed(1)}% is below threshold of ${(minSuccess * 100).toFixed(1)}%`,
      {
        reason: 'PROBABILITY_TOO_LOW',
        ev: rawEv,
        taskReward,
        successProbability,
        estimatedCost,
        currency,
      },
    );
  }

  // 2. Expected Value (EV) Calculation
  // EV = (Reward * P(Success)) - Cost_API_LLM
  const ev = Number((taskReward * successProbability - estimatedCost).toFixed(6));

  // 3. Profitability Gate (EV must be strictly greater than minProfitFloor, default 0)
  if (ev <= minProfitFloor) {
    throw new TaskRejectedError(
      `Task rejected: negative or non-profitable Expected Value (EV = ${ev} ${currency}, Reward = ${taskReward}, Cost = ${estimatedCost})`,
      {
        reason: 'NEGATIVE_EXPECTED_VALUE',
        ev,
        taskReward,
        successProbability,
        estimatedCost,
        currency,
      },
    );
  }

  return {
    accepted: true,
    ev,
    taskReward,
    successProbability,
    estimatedCost,
    netMargin: taskReward > 0 ? Number((ev / taskReward).toFixed(4)) : 0,
    currency,
  };
}
