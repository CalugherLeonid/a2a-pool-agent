import { describe, expect, it, beforeEach } from 'vitest';
import { HTNPlanner } from '../htn/planner.js';
import { TaskGraph } from '../htn/types.js';
import { MorphlingReplanEngine } from '../htn/morphling-replan.js';
import type { Opportunity } from '../opportunity/types.js';

describe('HTN Planner & Morphling Dynamic In-Flight Re-planning (System 2)', () => {
  let planner: HTNPlanner;
  let replanEngine: MorphlingReplanEngine;

  beforeEach(() => {
    planner = new HTNPlanner();
    replanEngine = new MorphlingReplanEngine();
  });

  const sampleOpp: Opportunity = {
    id: 'opp-htn-decomp',
    source: 'market-pool',
    title: 'Generate Decentralized Risk Assessment Model',
    description: 'Decompose risk assessment into data extraction, model synthesis, and verification',
    payment: { amount: 1.0, currency: 'USDC', chain: 'solana' },
    deadline: new Date(Date.now() + 120000).toISOString(),
    skillsRequired: ['code-generation'],
    discoveredAt: new Date().toISOString(),
  };

  it('decomposes compound goal into dependency-ordered TaskGraph', () => {
    const graph = planner.decompose(sampleOpp);

    expect(graph).toBeInstanceOf(TaskGraph);
    expect(graph.goal).toBe(sampleOpp.title);
    expect(graph.tasks.size).toBe(3);

    // Topological order succeeds without cyclic dependency
    const order = graph.topologicalOrder();
    expect(order.length).toBe(3);

    // Initial ready tasks: only Stage 1 (preprocessing) has 0 dependencies
    const ready = graph.getReadyTasks();
    expect(ready.length).toBe(1);
    expect(ready[0]!.skillRequired).toBe('analysis');
    expect(ready[0]!.status).toBe('PENDING');
  });

  it('advances ready tasks as dependencies transition to COMPLETED', () => {
    const graph = planner.decompose(sampleOpp);
    const order = graph.topologicalOrder();
    const task1 = graph.getTask(order[0]!)!;
    const task2 = graph.getTask(order[1]!)!;
    const task3 = graph.getTask(order[2]!)!;

    expect(graph.isCompleted()).toBe(false);

    // Initially only task1 is ready
    expect(graph.getReadyTasks().map((t) => t.id)).toEqual([task1.id]);

    // Mark task1 COMPLETED
    task1.status = 'COMPLETED';
    // Now task2 should be ready
    expect(graph.getReadyTasks().map((t) => t.id)).toEqual([task2.id]);

    // Mark task2 COMPLETED
    task2.status = 'COMPLETED';
    // Now task3 should be ready
    expect(graph.getReadyTasks().map((t) => t.id)).toEqual([task3.id]);

    // Mark task3 COMPLETED
    task3.status = 'COMPLETED';
    expect(graph.getReadyTasks().length).toBe(0);
    expect(graph.isCompleted()).toBe(true);
    expect(graph.hasFailedTasks()).toBe(false);
  });

  it('Morphling replanning - Strategy 1: in-place adaptive parameter retry on transient failure', async () => {
    const graph = planner.decompose(sampleOpp);
    const readyTasks = graph.getReadyTasks();
    const task = readyTasks[0]!;
    const initialBudget = task.maxBudgetUsd;

    // Simulate transient subtask failure
    const recovered = await replanEngine.handleSubtaskFailure(
      graph,
      task,
      'Transient rate limit or network timeout',
    );

    expect(recovered).toBe(true);
    // Task reset to PENDING with adapted budget and retry increment
    expect(task.status).toBe('PENDING');
    expect(task.retryCount).toBe(1);
    expect(task.maxBudgetUsd).toBeGreaterThan(initialBudget);
  });

  it('Morphling replanning - Strategy 3: dynamic node decomposition when retries exhausted', async () => {
    const graph = planner.decompose(sampleOpp);
    const order = graph.topologicalOrder();
    const task2 = graph.getTask(order[1]!)!; // Primary synthesis node
    const task3 = graph.getTask(order[2]!)!; // Dependent verification node

    // Exhaust retries on task 2
    task2.retryCount = task2.maxRetries;

    const initialTaskCount = graph.tasks.size;
    const recovered = await replanEngine.handleSubtaskFailure(
      graph,
      task2,
      'Complex synthesis model compilation error',
    );

    expect(recovered).toBe(true);
    // The failed monolithic task is cancelled
    expect(task2.status).toBe('CANCELLED');

    // 2 fallback subtasks were dynamically injected into the graph
    expect(graph.tasks.size).toBe(initialTaskCount + 2);

    // Downstream task3 had its dependencies dynamically rewired to the new recovery branch
    expect(task3.dependencies.includes(task2.id)).toBe(false);
    expect(task3.dependencies.some((d) => d.includes('-fb-b-'))).toBe(true);

    // The graph topological ordering remains valid and acyclic
    const newOrder = graph.topologicalOrder();
    expect(newOrder.length).toBe(graph.tasks.size);
  });
});
