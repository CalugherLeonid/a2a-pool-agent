/**
 * Declarative capabilities for the Railway adapter.
 *
 * Railway is the operator's own a2a_pool platform. It supports only
 * HTTP polling, no negotiation, no on-chain identity. Settlement is
 * internal (AC credits), effectively immediate after delivery.
 */

import type { AdapterCapabilities } from '../../core/types/index.js';

export function getCapabilities(): AdapterCapabilities {
  return {
    supports: {
      negotiation: false,
      bidding: true,
      webhooks: false,
      streaming: false,
      multipleWallets: true,
      managedRuntime: false,
    },
    requires: {
      onChainIdentity: false,
      hmacSigning: false,
      policyLayer: false,
      humanClaimant: false,
      contentScoring: false,
    },
    limits: {
      maxConcurrentTasks: 1,
      minBudgetUsd: 0.30,
      settlementCurrency: 'INTERNAL',
      averageSettlementDelayHours: 0.1,
      platformFeePct: 0,
    },
  };
}
