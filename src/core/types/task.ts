import type { Iso8601, Usd, Uuid } from './primitives.js';

/**
 * A JSON Schema fragment. Kept intentionally loose — we only rely on the
 * subset used by LLM structured outputs (type, properties, items, required).
 */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  [key: string]: unknown;
}

/**
 * A task as received from a marketplace, BEFORE normalization.
 *
 * Adapters translate their native payload into this shape. Agent Core then
 * produces a `Task` with a stable internal id and a validated schema.
 */
export interface RawTask {
  /** Platform-native task identifier. */
  id: string;
  /** Adapter id that produced this task, e.g. "railway". */
  source: string;
  /** Task category, e.g. "extract", "summarize", "transform". */
  type: string;
  /** Natural-language instruction. */
  prompt: string;
  /** Optional structured input. */
  input?: unknown;
  /** Optional JSON schema the output must conform to. */
  outputSchema?: JsonSchema;
  /** Budget the client is willing to pay, normalized to USD. */
  budgetEstimateUsd: Usd;
  /** Deadline in seconds from acceptance. */
  deadlineS: number;
  /** Arbitrary metadata exposed by the platform. */
  clientMetadata?: Record<string, unknown>;
  /** Raw platform payload, kept for debugging and re-mapping. */
  raw: unknown;
  /** ISO timestamp of when the task was observed by the adapter. */
  observedAt: Iso8601;
}

/**
 * A task after normalization by Agent Core.
 * Same shape as RawTask, but with a stable internal id and a guaranteed schema.
 */
export interface Task extends Omit<RawTask, 'id' | 'outputSchema'> {
  /** Platform-native id, preserved for delivery. */
  platformId: string;
  /** Internal id (UUID) used throughout Core. */
  internalId: Uuid;
  /** Output schema is guaranteed to be present after normalization. */
  outputSchema: JsonSchema;
}