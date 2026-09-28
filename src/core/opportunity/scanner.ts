/**
 * Opportunity Scanner.
 *
 * Continuously listens to and polls external sources, feeds, and broadcast channels
 * for available jobs, tasks, or sub-contracting opportunities published by other agents.
 *
 * Intercepts each opportunity and evaluates it through the EconomicBrain before any execution.
 */

import { createLogger } from '../../observability/logger.js';
import type { Opportunity, OpportunitySourceAdapter, EconomicDecision } from './types.js';
import type { EconomicBrain } from './economic-brain.js';

const log = createLogger('opportunity-scanner');

export interface OpportunityScannerOptions {
  brain: EconomicBrain;
  adapters?: OpportunitySourceAdapter[];
  pollIntervalMs?: number;
}

export class OpportunityScanner {
  private readonly brain: EconomicBrain;
  private readonly adapters: Map<string, OpportunitySourceAdapter> = new Map();
  private readonly pollIntervalMs: number;
  private pollingTimer?: NodeJS.Timeout;
  private isScanning = false;
  private readonly processedIds = new Set<string>();

  private readonly onDecisionCallbacks: Array<
    (opp: Opportunity, decision: EconomicDecision) => Promise<void> | void
  > = [];

  constructor(options: OpportunityScannerOptions) {
    this.brain = options.brain;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;

    if (options.adapters) {
      for (const adapter of options.adapters) {
        this.registerAdapter(adapter);
      }
    }
  }

  public registerAdapter(adapter: OpportunitySourceAdapter): void {
    this.adapters.set(adapter.id, adapter);
    log.info({ adapterId: adapter.id }, 'opportunity source adapter registered');
  }

  public unregisterAdapter(adapterId: string): void {
    this.adapters.delete(adapterId);
  }

  public onDecision(
    callback: (opp: Opportunity, decision: EconomicDecision) => Promise<void> | void,
  ): void {
    this.onDecisionCallbacks.push(callback);
  }

  /**
   * Polls all registered adapters for pending opportunities.
   */
  public async pollAll(): Promise<Opportunity[]> {
    const allOpportunities: Opportunity[] = [];

    for (const [adapterId, adapter] of this.adapters.entries()) {
      try {
        const opps = await adapter.pollOpportunities();
        if (Array.isArray(opps) && opps.length > 0) {
          log.info({ adapterId, count: opps.length }, 'polled opportunities from adapter');
          allOpportunities.push(...opps);
        }
      } catch (err) {
        log.warn({ adapterId, err }, 'error polling opportunities from adapter');
      }
    }

    return allOpportunities;
  }

  /**
   * Polls all sources and immediately evaluates newly discovered opportunities
   * using the EconomicBrain.
   */
  public async scanAndEvaluate(
    currentWorkload = 0,
  ): Promise<Array<{ opportunity: Opportunity; decision: EconomicDecision }>> {
    const rawOpps = await this.pollAll();
    const evaluated: Array<{ opportunity: Opportunity; decision: EconomicDecision }> = [];

    for (const opp of rawOpps) {
      if (this.processedIds.has(opp.id)) {
        continue;
      }
      this.processedIds.add(opp.id);

      const decision = await this.brain.evaluate(opp, currentWorkload);

      log.info(
        {
          opportunityId: opp.id,
          action: decision.action,
          offeredPayout: decision.offeredPayout,
          estimatedCost: decision.estimatedCost,
          expectedProfit: decision.expectedProfit,
          justification: decision.justification,
        },
        'opportunity evaluated by economic brain',
      );

      evaluated.push({ opportunity: opp, decision });

      // Notify registered callbacks (e.g. agent core pipeline)
      for (const cb of this.onDecisionCallbacks) {
        try {
          await cb(opp, decision);
        } catch (err) {
          log.error({ err, opportunityId: opp.id }, 'opportunity decision listener error');
        }
      }
    }

    return evaluated;
  }

  /**
   * Starts background recurring scanning loop.
   */
  public start(currentWorkloadProvider?: () => number): void {
    if (this.isScanning) {
      return;
    }
    this.isScanning = true;
    log.info({ intervalMs: this.pollIntervalMs }, 'opportunity scanner background loop started');

    const tick = async () => {
      if (!this.isScanning) return;
      try {
        const workload = currentWorkloadProvider ? currentWorkloadProvider() : 0;
        await this.scanAndEvaluate(workload);
      } catch (err) {
        log.error({ err }, 'error in opportunity scanner background tick');
      } finally {
        if (this.isScanning) {
          this.pollingTimer = setTimeout(tick, this.pollIntervalMs);
        }
      }
    };

    this.pollingTimer = setTimeout(tick, 50);
  }

  /**
   * Stops background scanning loop.
   */
  public stop(): void {
    this.isScanning = false;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    log.info('opportunity scanner background loop stopped');
  }

  public isRunning(): boolean {
    return this.isScanning;
  }

  public getProcessedCount(): number {
    return this.processedIds.size;
  }

  public clearProcessed(): void {
    this.processedIds.clear();
  }
}
