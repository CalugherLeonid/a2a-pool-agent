/**
 * Translates between the Railway pool's wire format (snake_case) and
 * Agent Core's internal shape (camelCase RawTask).
 *
 * The mapper is deliberately tolerant: it accepts multiple field names
 * so that small evolutions on the pool side do not break the adapter.
 */

import type { JsonSchema, RawTask } from '../../core/types/index.js';

/**
 * Raw payload as returned by the pool. Field names mirror the pool's
 * snake_case JSON. Optional fields are tolerated when missing.
 */
export interface RailwayTaskPayload {
  task_id: string;
  type: string;
  prompt: string;
  input?: unknown;
  output_schema?: JsonSchema;
  /** Preferred field. */
  budget_estimate_usd?: number;
  /** Legacy field, accepted as fallback. */
  budget_usd?: number;
  deadline_s?: number;
  client_metadata?: Record<string, unknown>;
}

export function mapRailwayTask(payload: RailwayTaskPayload): RawTask {
  const budget = payload.budget_estimate_usd ?? payload.budget_usd ?? 0;

  return {
    id: payload.task_id,
    source: 'railway',
    type: payload.type,
    prompt: payload.prompt,
    input: payload.input,
    outputSchema: payload.output_schema,
    budgetEstimateUsd: budget,
    deadlineS: payload.deadline_s ?? 300,
    clientMetadata: payload.client_metadata,
    raw: payload,
    observedAt: new Date().toISOString(),
  };
}
