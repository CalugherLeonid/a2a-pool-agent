/**
 * Economics configuration loader.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const PerAdapterSchema = z.object({
  min_profit_usd: z.number().nonnegative().optional(),
  min_success_probability: z.number().min(0).max(1).optional(),
  min_time_adjusted_profit: z.number().nonnegative().optional(),
});

const ModelRouterSchema = z.object({
  mode: z.enum(['fixed', 'learning', 'hybrid']),
  fixed_model: z.string().min(1),
  min_samples_for_learning: z.number().int().positive(),
});

const EconomicsSchema = z.object({
  min_profit_usd: z.number().nonnegative(),
  min_success_probability: z.number().min(0).max(1),
  min_time_adjusted_profit: z.number().nonnegative(),
  success_probability_prior: z.number().min(0).max(1),
  learning_window_days: z.number().int().positive(),
  min_learning_events: z.number().int().positive(),
  estimated_gas_cost_usd: z.number().nonnegative(),
  delay_floor_hours: z.number().nonnegative(),
  model_router: ModelRouterSchema,
  per_adapter: z.record(z.string(), PerAdapterSchema).default({}),
});

export type EconomicsConfig = z.infer<typeof EconomicsSchema>;
export type ModelRouterConfig = z.infer<typeof ModelRouterSchema>;

export interface AdapterEconomics {
  minProfitUsd: number;
  minSuccessProbability: number;
  minTimeAdjustedProfit: number;
}

let cached: EconomicsConfig | undefined;

export function loadEconomics(path = 'config/economics.json'): EconomicsConfig {
  if (cached) return cached;
  const full = resolve(process.cwd(), path);
  const raw = readFileSync(full, 'utf8');
  cached = EconomicsSchema.parse(JSON.parse(raw));
  return cached;
}

export function thresholdsFor(
  config: EconomicsConfig,
  adapterId: string,
): AdapterEconomics {
  const override = config.per_adapter[adapterId] ?? {};
  return {
    minProfitUsd: override.min_profit_usd ?? config.min_profit_usd,
    minSuccessProbability:
      override.min_success_probability ?? config.min_success_probability,
    minTimeAdjustedProfit:
      override.min_time_adjusted_profit ?? config.min_time_adjusted_profit,
  };
}
