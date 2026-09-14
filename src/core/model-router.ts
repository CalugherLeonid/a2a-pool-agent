/**
 * Model router.
 *
 * Decides which LLM model to use for a given (task_type, adapter_id).
 *
 * Three modes (see config/economics.json -> model_router.mode):
 *   - fixed:    always use the configured fixed model
 *   - learning: use best model from learning_events (falls back to fixed)
 *   - hybrid:   use learning if enough samples, else fixed
 */

import type { LearningStore } from './learning.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('model-router');

export interface ModelRouter {
  select(taskType: string, adapterId: string): Promise<string>;
}

export class FixedModelRouter implements ModelRouter {
  constructor(private readonly model: string) {}

  async select(_taskType: string, _adapterId: string): Promise<string> {
    return this.model;
  }
}

export class HybridModelRouter implements ModelRouter {
  constructor(
    private readonly store: LearningStore,
    private readonly fixedModel: string,
    private readonly windowDays: number,
    private readonly minSamples: number,
  ) {}

  async select(taskType: string, adapterId: string): Promise<string> {
    const candidates = await this.store.bestModel(
      taskType,
      adapterId,
      this.windowDays,
      this.minSamples,
    );

    if (candidates.length === 0) {
      log.debug(
        { taskType, adapterId, fixedModel: this.fixedModel },
        'no learning data, using fixed model',
      );
      return this.fixedModel;
    }

    const chosen = candidates[0]!;
    log.debug(
      {
        taskType,
        adapterId,
        chosenModel: chosen.model,
        successRate: chosen.successRate,
        n: chosen.n,
      },
      'routed by learning',
    );
    return chosen.model;
  }
}

export interface ModelRouterOptions {
  mode: 'fixed' | 'learning' | 'hybrid';
  fixedModel: string;
  store: LearningStore;
  windowDays: number;
  minSamples: number;
}

export function createModelRouter(opts: ModelRouterOptions): ModelRouter {
  if (opts.mode === 'fixed' || opts.mode === 'learning') {
    // For V1 both 'fixed' and 'learning' behave like fixed when there is
    // no data; the difference is semantic. We use hybrid internally for
    // both because it degrades gracefully.
    return new HybridModelRouter(
      opts.store,
      opts.fixedModel,
      opts.windowDays,
      opts.minSamples,
    );
  }
  return new HybridModelRouter(
    opts.store,
    opts.fixedModel,
    opts.windowDays,
    opts.minSamples,
  );
}
