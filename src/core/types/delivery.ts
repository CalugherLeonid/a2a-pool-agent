import type {
  Ed25519Sig,
  LlmProvider,
  QualityScore,
  Sha256Hash,
  Usd,
} from './primitives.js';

export interface DeliveryMeta {
  model: string;
  provider: LlmProvider;
  tokensIn: number;
  tokensOut: number;
  costUsd: Usd;
  latencyMs: number;
  qualityScore: QualityScore;
  retries: number;
}

/**
 * The signed payload sent to a marketplace's `deliver()`.
 * `hash` is sha256 over the canonical JSON of `output`.
 * `sig` is an Ed25519 signature over the hash.
 */
export interface Delivery {
  taskId: string;
  workerId: string;
  output: unknown;
  hash: Sha256Hash;
  sig: Ed25519Sig;
  meta: DeliveryMeta;
}

/** Internal quality assessment produced before delivery. */
export interface QualityReport {
  score: QualityScore;
  schemaValid: boolean;
  hallucinationFlags: string[];
  decision: 'deliver' | 'retry' | 'fail';
  reason: string;
}