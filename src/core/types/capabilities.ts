import type { ChainId, CurrencyCode } from './primitives.js';

/**
 * Declarative description of what an adapter can do and what it requires.
 *
 * Agent Core reads this at startup and adapts its behavior:
 *   - enables negotiation when `supports.negotiation` is true
 *   - runs the policy layer when `requires.policyLayer` is true
 *   - expects a human claim gate when `requires.humanClaimant` is true
 *   - uses `limits.averageSettlementDelayHours` in time-adjusted profit
 */

export interface AdapterSupports {
  /** Adapter supports a `negotiate()` round-trip before accept/reject. */
  negotiation: boolean;
  /** Adapter supports submitting a bid instead of a direct accept. */
  bidding: boolean;
  /** Adapter can push events via webhooks (vs. polling only). */
  webhooks: boolean;
  /** Adapter supports server-sent events / streaming. */
  streaming: boolean;
  /** Adapter can hold multiple wallets under one agent identity. */
  multipleWallets: boolean;
  /** Adapter runs the agent inside its own managed runtime (e.g. Clustly). */
  managedRuntime: boolean;
}

export interface AdapterRequires {
  /** Adapter expects an on-chain identity (ERC-8004, Solana pubkey, ...). */
  onChainIdentity: boolean;
  /** Adapter requires HMAC-SHA256 signed requests (e.g. dealwork.ai). */
  hmacSigning: boolean;
  /** Adapter exposes destructive tools; a policy layer must gate them. */
  policyLayer: boolean;
  /** Payout is released to a human claimant, not directly to the agent. */
  humanClaimant: boolean;
  /** Adapter scores content quality (e.g. Xyper). */
  contentScoring: boolean;
}

export interface AdapterLimits {
  maxConcurrentTasks: number;
  minBudgetUsd: number;
  maxBudgetUsd?: number;
  settlementCurrency: CurrencyCode;
  settlementChain?: ChainId;
  /**
   * Expected settlement delay in hours.
   * Used by the economic triage to compute time-adjusted profit.
   */
  averageSettlementDelayHours: number;
  /**
   * Platform fee as a fraction of revenue (0..1).
   * e.g. 0.10 for a 10% fee. Applied to expected revenue in the
   * economic triage formula.
   */
  platformFeePct: number;
}

export interface AdapterCapabilities {
  supports: AdapterSupports;
  requires: AdapterRequires;
  limits: AdapterLimits;
}
