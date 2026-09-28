/**
 * Opportunity & Economic Decision Data Models.
 *
 * Defines the contract for external tasks, jobs, or requests discovered across
 * networks, marketplaces, and local feeds.
 */

export interface OpportunityPayment {
  amount: number;
  currency: 'USDC' | 'SOL' | 'USDT' | 'USD' | string;
  chain?: 'solana' | 'ethereum' | 'railway' | 'okx' | string;
}

export interface Opportunity {
  id: string;
  source: string;
  title: string;
  description: string;
  payment: OpportunityPayment;
  /** ISO timestamp deadline */
  deadline: string;
  skillsRequired: string[];
  risk?: 'low' | 'medium' | 'high';
  applyUrl?: string;
  payload?: Record<string, unknown>;
  discoveredAt: string;
  signature?: string;
  requesterAgentId?: string;
  requesterPubkey?: string;
}

export interface OpportunitySourceAdapter {
  readonly id: string;
  pollOpportunities(): Promise<Opportunity[]>;
}

export type EconomicAction = 'ACCEPT' | 'REJECT' | 'COUNTER_OFFER';

export interface EconomicDecision {
  action: EconomicAction;
  opportunityId: string;
  estimatedCost: number;
  offeredPayout: number;
  expectedProfit: number;
  roiPercentage: number;
  counterOfferPrice?: number;
  permissionGranted: boolean;
  justification: string;
  breakdown: {
    skillMatch: boolean;
    missingSkills: string[];
    reputationScore: number;
    reputationPassed: boolean;
    profitabilityPassed: boolean;
    deadlineFeasible: boolean;
    capacityAvailable: boolean;
    escrowSafe: boolean;
  };
}
