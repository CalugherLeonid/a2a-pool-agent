/**
 * Hierarchical Task Network (HTN) & TaskGraph Engine Data Models.
 *
 * Exclusively used by System 2 for deep goal decomposition, dynamic planning,
 * and resilient in-flight task execution.
 */

export type SubTaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'REPLANNING'
  | 'CANCELLED';

export interface SubTask {
  id: string;
  title: string;
  description: string;
  skillRequired: string;
  dependencies: string[];
  status: SubTaskStatus;
  assignedAgent?: string;
  inputData: Record<string, unknown>;
  outputData?: Record<string, unknown>;
  estimatedCostUsd: number;
  maxBudgetUsd: number;
  executionTimeoutMs: number;
  error?: string;
  retryCount: number;
  maxRetries: number;
  startedAt?: Date;
  completedAt?: Date;
}

export class TaskGraph {
  public readonly id: string;
  public readonly goal: string;
  public readonly tasks: Map<string, SubTask> = new Map();
  public readonly metadata: Record<string, unknown>;

  constructor(id: string, goal: string, metadata: Record<string, unknown> = {}) {
    this.id = id;
    this.goal = goal;
    this.metadata = metadata;
  }

  public addTask(task: SubTask): void {
    this.tasks.set(task.id, task);
  }

  public getTask(id: string): SubTask | undefined {
    return this.tasks.get(id);
  }

  public getAllTasks(): SubTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Returns tasks whose dependencies are all COMPLETED and are currently in PENDING state.
   */
  public getReadyTasks(): SubTask[] {
    const ready: SubTask[] = [];

    for (const task of this.tasks.values()) {
      if (task.status !== 'PENDING') {
        continue;
      }

      const allDepsMet = task.dependencies.every((depId) => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === 'COMPLETED';
      });

      if (allDepsMet) {
        ready.push(task);
      }
    }

    return ready;
  }

  /**
   * Checks if all tasks in the graph have concluded (COMPLETED or CANCELLED).
   */
  public isCompleted(): boolean {
    if (this.tasks.size === 0) return true;
    for (const task of this.tasks.values()) {
      if (task.status !== 'COMPLETED' && task.status !== 'CANCELLED') {
        return false;
      }
    }
    return true;
  }

  /**
   * Checks if there are any unhandled failed tasks in the graph.
   */
  public hasFailedTasks(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'FAILED') {
        return true;
      }
    }
    return false;
  }

  /**
   * Calculates execution sequence via Kahn's algorithm.
   * Throws Error if cyclic dependency exists.
   */
  public topologicalOrder(): string[] {
    const inDegree = new Map<string, number>();
    for (const [id, task] of this.tasks.entries()) {
      inDegree.set(id, task.dependencies.length);
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) {
        queue.push(id);
      }
    }

    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);

      for (const task of this.tasks.values()) {
        if (task.dependencies.includes(current)) {
          const currentDeg = (inDegree.get(task.id) ?? 1) - 1;
          inDegree.set(task.id, currentDeg);
          if (currentDeg === 0) {
            queue.push(task.id);
          }
        }
      }
    }

    if (order.length !== this.tasks.size) {
      throw new Error(`Cyclic dependency detected in TaskGraph ${this.id}`);
    }

    return order;
  }

  public toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      goal: this.goal,
      metadata: this.metadata,
      tasks: Array.from(this.tasks.entries()).map(([id, t]) => ({
        ...t,
        id,
      })),
      isCompleted: this.isCompleted(),
      hasFailedTasks: this.hasFailedTasks(),
    };
  }
}
