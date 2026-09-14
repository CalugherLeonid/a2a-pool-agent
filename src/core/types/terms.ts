import type { Probability, Usd } from './primitives.js';

/**
 * Terms proposed by Agent Core when accepting a task.
 * Sent to `MarketplaceAdapter.accept()`.
 */
export interface Terms {
  estimatedCostUsd: Usd;
  estimatedTimeS: number;
  model: string;
  confidence: Probability;
  strategyId: string;
  maxRetries: number;
}

export interface AcceptanceResult {
  accepted: boolean;
  platformTaskId: string;
  /** ISO timestamp until which the platform has locked the task. */
  lockedUntil: string;
  terms: Terms;
  /** Rejection reason if `accepted === false`. */
  reason?: string;
}

export interface NegotiationResult {
  /** Whether the marketplace accepted the counter-offer. */
  accepted: boolean;
  /** Final terms after negotiation. */
  finalTerms: Terms;
  /** Counter-offer amount, if the marketplace proposed one. */
  counterOfferUsd?: Usd;
  reason?: string;
}