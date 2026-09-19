/**
 * Budget guard.
 *
 * Tracks how much the agent has spent today (UTC) and refuses to
 * accept tasks whose expected cost would exceed the daily cap.
 *
 * Persisted via learning_events.actual_cost_usd — the source of truth
 * is the database, hydrated at startup.
 *
 * This is a hard gate: Agent Core checks it BEFORE calling accept().
 */

import type { Usd } from './types/index.js';
import type { LearningStore } from './learning.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('budget');

export interface BudgetGuardConfig {
  dailyCapUsd: Usd;
  store: LearningStore;
}

export class BudgetGuard {
  private usedTodayUsd = 0;
  private lastResetDate: string;

  constructor(private readonly config: BudgetGuardConfig) {
    this.lastResetDate = this.todayUtc();
  }

  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Load today's spend from the database. Call once at startup. */
  async hydrate(): Promise<void> {
    try {
      const used = await this.config.store.costToday();
      this.usedTodayUsd = used;
      this.lastResetDate = this.todayUtc();
      log.info(
        { usedUsd: used, capUsd: this.config.dailyCapUsd },
        'budget hydrated from learning events',
      );
    } catch (err) {
      log.error({ err }, 'budget hydrate failed — starting from 0');
      this.usedTodayUsd = 0;
    }
  }

  private rolloverIfNeeded(): void {
    const today = this.todayUtc();
    if (today !== this.lastResetDate) {
      log.info(
        { previousUsed: this.usedTodayUsd, newDay: today },
        'budget day rolled over',
      );
      this.usedTodayUsd = 0;
      this.lastResetDate = today;
    }
  }

  /** Would accepting a task with this expected cost exceed the cap? */
  wouldExceed(estimateUsd: Usd): boolean {
    this.rolloverIfNeeded();
    return this.usedTodayUsd + estimateUsd > this.config.dailyCapUsd;
  }

  /** Record actual cost after execution (success or failure). */
  record(actualUsd: Usd): void {
    this.rolloverIfNeeded();
    this.usedTodayUsd += actualUsd;
  }

  get used(): Usd {
    return this.usedTodayUsd;
  }

  get cap(): Usd {
    return this.config.dailyCapUsd;
  }

  get remaining(): Usd {
    return Math.max(0, this.config.dailyCapUsd - this.usedTodayUsd);
  }

  isExhausted(): boolean {
    this.rolloverIfNeeded();
    return this.usedTodayUsd >= this.config.dailyCapUsd;
  }

  snapshot(): { dailyUsed: Usd; dailyCap: Usd } {
    this.rolloverIfNeeded();
    return {
      dailyUsed: this.usedTodayUsd,
      dailyCap: this.config.dailyCapUsd,
    };
  }
}
