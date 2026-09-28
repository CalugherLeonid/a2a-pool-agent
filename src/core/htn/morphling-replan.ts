/**
 * Morphling In-Flight Dynamic Re-planning Loop (System 2).
 *
 * Intercepts subtask failures, timeouts, and circuit-breaker open errors
 * in the active TaskGraph and performs adaptive in-flight recovery:
 *   1. Bounded parameter adaptation & retry with adjusted budget/timeouts
 *   2. Skill / Peer fallback re-routing
 *   3. Dynamic node decomposition: splits failed monolithic task into 2 resilient
 *      atomic recovery subtasks and rewires downstream dependencies without crashing the goal.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';
import { TaskGraph, type SubTask } from './types.js';

const log = createLogger('morphling-replan');

export class MorphlingReplanEngine {
  private readonly healingAttempts = new Map<string, number>();

  /**
   * Handles a subtask failure by dynamically mutating the active TaskGraph in-flight.
   * Returns true if the graph was mutated and execution can resume, false if unrecoverable.
   */
  public async handleSubtaskFailure(
    graph: TaskGraph,
    failedTask: SubTask,
    error: string,
  ): Promise<boolean> {
    log.warn(
      {
        graphId: graph.id,
        taskId: failedTask.id,
        title: failedTask.title,
        error,
        retryCount: failedTask.retryCount,
        maxRetries: failedTask.maxRetries,
      },
      'morphling intercepted subtask failure in taskgraph',
    );

    failedTask.status = 'REPLANNING';
    failedTask.error = error;

    const attempts = (this.healingAttempts.get(failedTask.id) ?? 0) + 1;
    this.healingAttempts.set(failedTask.id, attempts);

    // Strategy 1: Adaptive in-place retry with increased budget
    if (failedTask.retryCount < failedTask.maxRetries) {
      failedTask.retryCount++;
      failedTask.estimatedCostUsd = Math.round(failedTask.estimatedCostUsd * 1.25 * 1000) / 1000;
      failedTask.maxBudgetUsd = Math.round(failedTask.maxBudgetUsd * 1.25 * 1000) / 1000;
      failedTask.executionTimeoutMs = Math.round(failedTask.executionTimeoutMs * 1.5);
      failedTask.status = 'PENDING';

      log.info(
        {
          taskId: failedTask.id,
          attempt: failedTask.retryCount,
          max: failedTask.maxRetries,
          newBudget: failedTask.maxBudgetUsd,
        },
        'morphling: adapted subtask parameters for in-place retry',
      );
      return true;
    }

    // Strategy 2: If peer delegation failed, reroute to local fallback skill
    if (failedTask.assignedAgent && attempts <= failedTask.maxRetries + 1) {
      log.info(
        { taskId: failedTask.id, formerPeer: failedTask.assignedAgent },
        'morphling: peer delegation degraded, rerouting to local sovereign execution',
      );
      failedTask.assignedAgent = undefined; // Force local execution
      failedTask.skillRequired = 'analysis'; // Fallback to deterministic local path
      failedTask.status = 'PENDING';
      return true;
    }

    // Strategy 3: Dynamic node decomposition
    // Split the failed monolithic node into 2 recovery subtasks:
    //   Node A: Resilient partial computation
    //   Node B: Verification and fallback assembly
    log.info(
      { taskId: failedTask.id },
      'morphling: retries exhausted, dynamically decomposing failed task into recovery branch',
    );

    const fallbackAId = `${failedTask.id}-fb-a-${randomUUID().substring(0, 4)}`;
    const fallbackBId = `${failedTask.id}-fb-b-${randomUUID().substring(0, 4)}`;

    const fallbackA: SubTask = {
      id: fallbackAId,
      title: `Fallback Step 1 for: ${failedTask.title}`,
      description: `Resilient decomposed computation recovering from: ${error}`,
      skillRequired: 'analysis',
      dependencies: [...failedTask.dependencies],
      status: 'PENDING',
      inputData: { ...failedTask.inputData, fallbackMode: true, previousError: error },
      estimatedCostUsd: Math.round(failedTask.estimatedCostUsd * 0.5 * 1000) / 1000,
      maxBudgetUsd: failedTask.maxBudgetUsd * 0.5,
      executionTimeoutMs: Math.round(failedTask.executionTimeoutMs * 0.75),
      retryCount: 0,
      maxRetries: 1,
    };

    const fallbackB: SubTask = {
      id: fallbackBId,
      title: `Fallback Step 2 for: ${failedTask.title}`,
      description: 'Re-assembly and validation of fallback branch outputs.',
      skillRequired: 'verification',
      dependencies: [fallbackAId],
      status: 'PENDING',
      inputData: { ...failedTask.inputData, previousTaskId: failedTask.id },
      estimatedCostUsd: Math.round(failedTask.estimatedCostUsd * 0.5 * 1000) / 1000,
      maxBudgetUsd: failedTask.maxBudgetUsd * 0.5,
      executionTimeoutMs: Math.round(failedTask.executionTimeoutMs * 0.75),
      retryCount: 0,
      maxRetries: 1,
    };

    // Rewire all downstream tasks that depended on the failed task
    for (const downstreamTask of graph.tasks.values()) {
      if (downstreamTask.dependencies.includes(failedTask.id)) {
        downstreamTask.dependencies = downstreamTask.dependencies.filter(
          (d) => d !== failedTask.id,
        );
        downstreamTask.dependencies.push(fallbackBId);
        log.info(
          { downstreamTaskId: downstreamTask.id, rewiredTo: fallbackBId },
          'morphling: rewired downstream dependency to fallback assembly node',
        );
      }
    }

    // Add new fallback nodes and cancel failed node
    graph.addTask(fallbackA);
    graph.addTask(fallbackB);
    failedTask.status = 'CANCELLED';

    log.info(
      { failedTaskId: failedTask.id, injectedNodes: [fallbackAId, fallbackBId] },
      'morphling: taskgraph dynamically mutated with active recovery branch',
    );

    return true;
  }
}
