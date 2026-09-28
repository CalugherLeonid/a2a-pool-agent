/**
 * Hierarchical Task Network (HTN) Planner (System 2 Only).
 *
 * Decomposes high-level goals and compound opportunities into
 * dependency-ordered TaskGraphs.
 *
 * System 1 (fast-path deterministic) must NEVER call or mutate this.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';
import { TaskGraph, type SubTask } from './types.js';
import type { Opportunity } from '../opportunity/types.js';

const log = createLogger('htn-planner');

export type DecompositionRule = (
  goal: string,
  inputData: Record<string, unknown>,
  context?: Record<string, unknown>,
) => TaskGraph;

export class HTNPlanner {
  private readonly rules: Map<string, DecompositionRule> = new Map();

  constructor() {
    this.registerDefaultRules();
  }

  public registerRule(skillOrType: string, rule: DecompositionRule): void {
    this.rules.set(skillOrType, rule);
  }

  /**
   * Decomposes a compound goal or Opportunity into an executable TaskGraph.
   */
  public decompose(
    target:
      | Opportunity
      | {
          id?: string;
          goal: string;
          skill?: string;
          input?: Record<string, unknown>;
          maxBudgetUsd?: number;
        },
  ): TaskGraph {
    const isOpp = 'skillsRequired' in target;
    const goal = isOpp ? target.title : target.goal;
    const skill = isOpp ? target.skillsRequired[0] ?? 'synthesis' : target.skill ?? 'synthesis';
    const inputData = isOpp ? target.payload ?? {} : target.input ?? {};
    const graphId = `graph-${randomUUID().substring(0, 8)}`;
    const budget = isOpp ? target.payment?.amount ?? 0.05 : target.maxBudgetUsd ?? 0.05;

    // Check if a registered domain rule matches
    const customRule = this.rules.get(skill);
    if (customRule) {
      log.info({ skill, goal }, 'decomposing via custom domain HTN rule');
      return customRule(goal, inputData, { opportunityId: isOpp ? target.id : undefined, budget });
    }

    // Default System 2 decomposition pipeline
    log.info({ skill, goal }, 'decomposing via System 2 standard 3-stage HTN pipeline');
    const graph = new TaskGraph(graphId, goal, {
      skill,
      budget,
      opportunityId: isOpp ? target.id : undefined,
    });

    // 1. Stage 1: Preprocessing & Context Extraction
    const t1: SubTask = {
      id: `task-${randomUUID().substring(0, 8)}`,
      title: `Preprocess & Analyze: ${goal}`,
      description: 'Validate input parameters, extract schema constraints and boundary checks.',
      skillRequired: 'analysis',
      dependencies: [],
      status: 'PENDING',
      inputData,
      estimatedCostUsd: Math.round(budget * 0.15 * 1000) / 1000,
      maxBudgetUsd: budget * 0.25,
      executionTimeoutMs: 15000,
      retryCount: 0,
      maxRetries: 2,
    };

    // 2. Stage 2: Primary Synthesis / Deep Execution
    const t2: SubTask = {
      id: `task-${randomUUID().substring(0, 8)}`,
      title: `Primary Execution: ${goal}`,
      description: 'Execute deep synthesis, code generation, or delegated A2A computation.',
      skillRequired: skill,
      dependencies: [t1.id],
      status: 'PENDING',
      inputData,
      estimatedCostUsd: Math.round(budget * 0.65 * 1000) / 1000,
      maxBudgetUsd: budget * 0.70,
      executionTimeoutMs: 30000,
      retryCount: 0,
      maxRetries: 2,
    };

    // 3. Stage 3: Verification & Quality Assurance (EvalPack)
    const t3: SubTask = {
      id: `task-${randomUUID().substring(0, 8)}`,
      title: `Verify & Quality Check: ${goal}`,
      description: 'Run zero-trust EvalPack assertions and output format verification.',
      skillRequired: 'verification',
      dependencies: [t2.id],
      status: 'PENDING',
      inputData,
      estimatedCostUsd: Math.round(budget * 0.10 * 1000) / 1000,
      maxBudgetUsd: budget * 0.15,
      executionTimeoutMs: 10000,
      retryCount: 0,
      maxRetries: 1,
    };

    graph.addTask(t1);
    graph.addTask(t2);
    graph.addTask(t3);

    return graph;
  }

  private registerDefaultRules(): void {
    // Market Arbitrage / Financial workflow
    this.registerRule('arbitrage', (goal, inputData, context) => {
      const graphId = `graph-arb-${randomUUID().substring(0, 8)}`;
      const graph = new TaskGraph(graphId, goal, context ?? {});

      const t1: SubTask = {
        id: `task-${randomUUID().substring(0, 8)}`,
        title: 'Fetch Order Book & Liquidity',
        description: 'Query decentralized marketplace liquidity pools and order book depth.',
        skillRequired: 'market_data_ingest',
        dependencies: [],
        status: 'PENDING',
        inputData,
        estimatedCostUsd: 0.002,
        maxBudgetUsd: 0.01,
        executionTimeoutMs: 10000,
        retryCount: 0,
        maxRetries: 2,
      };

      const t2: SubTask = {
        id: `task-${randomUUID().substring(0, 8)}`,
        title: 'Compute Net Spread & Gas Floor',
        description: 'Calculate net profit margin taking platform fee and slippage into account.',
        skillRequired: 'arbitrage_eval',
        dependencies: [t1.id],
        status: 'PENDING',
        inputData,
        estimatedCostUsd: 0.005,
        maxBudgetUsd: 0.02,
        executionTimeoutMs: 15000,
        retryCount: 0,
        maxRetries: 2,
      };

      const t3: SubTask = {
        id: `task-${randomUUID().substring(0, 8)}`,
        title: 'Lock Escrow & Execute Settlement',
        description: 'Lock atomic escrow and dispatch signed execution receipt.',
        skillRequired: 'settlement_escrow',
        dependencies: [t2.id],
        status: 'PENDING',
        inputData,
        estimatedCostUsd: 0.003,
        maxBudgetUsd: 0.01,
        executionTimeoutMs: 15000,
        retryCount: 0,
        maxRetries: 1,
      };

      graph.addTask(t1);
      graph.addTask(t2);
      graph.addTask(t3);
      return graph;
    });
  }
}
