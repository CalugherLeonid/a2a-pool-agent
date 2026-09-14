/**
 * Mock adapter capabilities.
 *
 * The mock behaves like a simple, non-negotiating marketplace. It is
 * only used during development to exercise the full Agent Core loop
 * without depending on an external platform.
 */

import type { AdapterCapabilities } from '../../core/types/index.js';

export function getCapabilities(): AdapterCapabilities {
  return {
    supports: {
      negotiation: false,
      bidding: false,
      webhooks: false,
      streaming: false,
      multipleWallets: false,
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
      averageSettlementDelayHours: 0,
      platformFeePct: 0,
    },
  };
}
