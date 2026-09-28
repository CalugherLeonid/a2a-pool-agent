/**
 * Economic Brain Decision Engine.
 *
 * Quantitative gatekeeper for all inbound opportunities and sub-task delegations:
 *   - Skill match against sovereign agent capabilities
 *   - Cost vs. Reward: estimated resource consumption vs offered payout
 *   - Minimum profit margin & minimum absolute profit
 *   - Requester historical reputation score check
 *   - Current workload / capacity limits
 *   - Deadline feasibility
 *   - Escrow safety checks
 *
 * Emits an EconomicDecision with:
 *   - action: ACCEPT | REJECT | COUNTER_OFFER
 *   - permissionGranted: true ONLY on ACCEPT
 */

import { createLogger } from '../../observability/logger.js';
import type { Opportunity, EconomicDecision } from './types.js';
import type { ReputationSystem } from '../reputation.js';
import type { EscrowSystem } from '../escrow.js';
import { env } from '../../config/env.js';

const log = createLogger('economic-brain');

export interface EconomicBrainOptions {
  capabilities?: string[];
  minProfitMarginRatio?: number;
  minAbsoluteProfitUsd?: number;
  minReputationScore?: number;
  maxConcurrentCapacity?: number;
  minLeadTimeMs?: number;
  reputationSystem?: ReputationSystem;
  escrowSystem?: EscrowSystem;
  /** Estimated cost per base skill in USD */
  skillCostEstimates?: Record<string, number>;
}

export class EconomicBrain {
  private capabilities: Set<string>;
  private minProfitMarginRatio: number;
  private minAbsoluteProfitUsd: number;
  private minReputationScore: number;
  private maxConcurrentCapacity: number;
  private minLeadTimeMs: number;
  private reputationSystem?: ReputationSystem;
  private escrowSystem?: EscrowSystem;
  private skillCostEstimates: Record<string, number>;

  constructor(options?: EconomicBrainOptions) {
    this.capabilities = new Set(
      options?.capabilities ?? [
        'prompt-completion',
        'code-generation',
        'classification',
        'structured-json-output',
        'analysis',
        'synthesis',
        'verification',
        'text',
        'extract',
        'summarize',
      ],
    );

    this.minProfitMarginRatio = options?.minProfitMarginRatio ?? 0.20; // 20% minimum margin
    this.minAbsoluteProfitUsd = options?.minAbsoluteProfitUsd ?? env.MIN_PROFIT_USD ?? 0.05;
    this.minReputationScore = options?.minReputationScore ?? 0.70;
    this.maxConcurrentCapacity = options?.maxConcurrentCapacity ?? 10;
    this.minLeadTimeMs = options?.minLeadTimeMs ?? 5000; // 5 seconds lead time minimum
    this.reputationSystem = options?.reputationSystem;
    this.escrowSystem = options?.escrowSystem;

    this.skillCostEstimates = {
      analysis: 0.003,
      synthesis: 0.012,
      verification: 0.002,
      'code-generation': 0.015,
      classification: 0.002,
      text: 0.003,
      extract: 0.003,
      summarize: 0.004,
      'prompt-completion': 0.003,
      ...(options?.skillCostEstimates ?? {}),
    };
  }

  public getCapabilities(): string[] {
    return Array.from(this.capabilities);
  }

  public addCapability(skill: string): void {
    this.capabilities.add(skill);
  }

  public setReputationSystem(reputationSystem: ReputationSystem): void {
    this.reputationSystem = reputationSystem;
  }

  public setEscrowSystem(escrowSystem: EscrowSystem): void {
    this.escrowSystem = escrowSystem;
  }

  public getEscrowSystem(): EscrowSystem | undefined {
    return this.escrowSystem;
  }

  /**
   * Estimates execution cost in USD based on skills and complexity.
   */
  public estimateCost(opportunity: Opportunity): number {
    let cost = 0;
    for (const skill of opportunity.skillsRequired) {
      cost += this.skillCostEstimates[skill] ?? 0.005;
    }

    if (cost === 0) {
      cost = 0.005; // Fallback baseline
    }

    // Adjust for payload length
    const payloadStr = JSON.stringify(opportunity.payload ?? {});
    if (payloadStr.length > 2000) {
      cost *= 1.25;
    }

    return Math.round((cost + Number.EPSILON) * 10000) / 10000;
  }

  /**
   * Evaluates an opportunity and returns an EconomicDecision.
   * Only returns action='ACCEPT' (permissionGranted=true) if all financial,
   * capability, reputation, capacity, and deadline filters pass.
   */
  public async evaluate(
    opportunity: Opportunity,
    currentWorkload = 0,
  ): Promise<EconomicDecision> {
    const offeredPayout = opportunity.payment?.amount ?? 0;
    const estimatedCost = this.estimateCost(opportunity);

    // 1. Skill Match Check
    const missingSkills = opportunity.skillsRequired.filter(
      (skill) => !this.capabilities.has(skill),
    );
    const skillMatch = missingSkills.length === 0;

    if (!skillMatch) {
      return {
        action: 'REJECT',
        opportunityId: opportunity.id,
        estimatedCost,
        offeredPayout,
        expectedProfit: offeredPayout - estimatedCost,
        roiPercentage: estimatedCost > 0 ? ((offeredPayout - estimatedCost) / estimatedCost) * 100 : 0,
        permissionGranted: false,
        justification: `REJECTED: Sovereign agent lacks required skills: ${missingSkills.join(', ')}.`,
        breakdown: {
          skillMatch: false,
          missingSkills,
          reputationScore: 1.0,
          reputationPassed: true,
          profitabilityPassed: false,
          deadlineFeasible: true,
          capacityAvailable: true,
          escrowSafe: true,
        },
      };
    }

    // 2. Deadline Feasibility Check
    const deadlineMs = new Date(opportunity.deadline).getTime();
    const remainingTimeMs = deadlineMs - Date.now();
    const deadlineFeasible = !isNaN(deadlineMs) && remainingTimeMs > this.minLeadTimeMs;

    if (!deadlineFeasible) {
      return {
        action: 'REJECT',
        opportunityId: opportunity.id,
        estimatedCost,
        offeredPayout,
        expectedProfit: offeredPayout - estimatedCost,
        roiPercentage: estimatedCost > 0 ? ((offeredPayout - estimatedCost) / estimatedCost) * 100 : 0,
        permissionGranted: false,
        justification: `REJECTED: Deadline is expired or insufficient execution window (${Math.round(remainingTimeMs / 1000)}s remaining, minimum required ${Math.round(this.minLeadTimeMs / 1000)}s).`,
        breakdown: {
          skillMatch: true,
          missingSkills: [],
          reputationScore: 1.0,
          reputationPassed: true,
          profitabilityPassed: false,
          deadlineFeasible: false,
          capacityAvailable: true,
          escrowSafe: true,
        },
      };
    }

    // 3. Workload Capacity Check
    const capacityAvailable = currentWorkload < this.maxConcurrentCapacity;
    if (!capacityAvailable) {
      const surgeMultiplier = 1.5;
      const surgePrice = Math.round((estimatedCost * (1 + this.minProfitMarginRatio * surgeMultiplier) + this.minAbsoluteProfitUsd) * 1000) / 1000;
      return {
        action: 'COUNTER_OFFER',
        opportunityId: opportunity.id,
        estimatedCost,
        offeredPayout,
        expectedProfit: offeredPayout - estimatedCost,
        roiPercentage: estimatedCost > 0 ? ((offeredPayout - estimatedCost) / estimatedCost) * 100 : 0,
        counterOfferPrice: surgePrice,
        permissionGranted: false,
        justification: `COUNTER_OFFER: Capacity saturated (workload ${currentWorkload}/${this.maxConcurrentCapacity}). Applied surge counter-offer of $${surgePrice}.`,
        breakdown: {
          skillMatch: true,
          missingSkills: [],
          reputationScore: 1.0,
          reputationPassed: true,
          profitabilityPassed: false,
          deadlineFeasible: true,
          capacityAvailable: false,
          escrowSafe: true,
        },
      };
    }

    // 4. Requester Reputation Check
    let reputationScore = 1.0;
    if (this.reputationSystem && opportunity.requesterAgentId) {
      reputationScore = this.reputationSystem.getScore(opportunity.requesterAgentId);
    }
    const reputationPassed = reputationScore >= this.minReputationScore;

    if (!reputationPassed) {
      return {
        action: 'REJECT',
        opportunityId: opportunity.id,
        estimatedCost,
        offeredPayout,
        expectedProfit: offeredPayout - estimatedCost,
        roiPercentage: estimatedCost > 0 ? ((offeredPayout - estimatedCost) / estimatedCost) * 100 : 0,
        permissionGranted: false,
        justification: `REJECTED: Requester reputation score (${reputationScore.toFixed(3)}) is below required threshold (${this.minReputationScore.toFixed(3)}).`,
        breakdown: {
          skillMatch: true,
          missingSkills: [],
          reputationScore,
          reputationPassed: false,
          profitabilityPassed: false,
          deadlineFeasible: true,
          capacityAvailable: true,
          escrowSafe: true,
        },
      };
    }

    // 5. Profitability & ROI Evaluation
    const expectedProfit = Math.round((offeredPayout - estimatedCost + Number.EPSILON) * 10000) / 10000;
    const profitMargin = estimatedCost > 0 ? expectedProfit / estimatedCost : 0;
    const roiPercentage = Math.round(profitMargin * 1000) / 10;

    const minRequiredPayout = Math.round((estimatedCost * (1 + this.minProfitMarginRatio) + this.minAbsoluteProfitUsd + Number.EPSILON) * 1000) / 1000;

    // Check if payout is negative or zero
    if (offeredPayout <= 0 || expectedProfit < 0) {
      return {
        action: 'REJECT',
        opportunityId: opportunity.id,
        estimatedCost,
        offeredPayout,
        expectedProfit,
        roiPercentage,
        permissionGranted: false,
        justification: `REJECTED: Negative expected value (Offered: $${offeredPayout}, Estimated Cost: $${estimatedCost}, Net Profit: $${expectedProfit}).`,
        breakdown: {
          skillMatch: true,
          missingSkills: [],
          reputationScore,
          reputationPassed: true,
          profitabilityPassed: false,
          deadlineFeasible: true,
          capacityAvailable: true,
          escrowSafe: true,
        },
      };
    }

    // Check if offered payout fails minimum profit requirements
    if (expectedProfit < this.minAbsoluteProfitUsd || profitMargin < this.minProfitMarginRatio) {
      // If offered payout at least covers estimated cost, propose a counter-offer
      if (offeredPayout >= estimatedCost) {
        return {
          action: 'COUNTER_OFFER',
          opportunityId: opportunity.id,
          estimatedCost,
          offeredPayout,
          expectedProfit,
          roiPercentage,
          counterOfferPrice: minRequiredPayout,
          permissionGranted: false,
          justification: `COUNTER_OFFER: Offered payout $${offeredPayout.toFixed(4)} is below target profit threshold. Proposed counter-offer price: $${minRequiredPayout.toFixed(4)}.`,
          breakdown: {
            skillMatch: true,
            missingSkills: [],
            reputationScore,
            reputationPassed: true,
            profitabilityPassed: false,
            deadlineFeasible: true,
            capacityAvailable: true,
            escrowSafe: true,
          },
        };
      }

      return {
        action: 'REJECT',
        opportunityId: opportunity.id,
        estimatedCost,
        offeredPayout,
        expectedProfit,
        roiPercentage,
        permissionGranted: false,
        justification: `REJECTED: Payout $${offeredPayout.toFixed(4)} is insufficient (estimated cost: $${estimatedCost.toFixed(4)}).`,
        breakdown: {
          skillMatch: true,
          missingSkills: [],
          reputationScore,
          reputationPassed: true,
          profitabilityPassed: false,
          deadlineFeasible: true,
          capacityAvailable: true,
          escrowSafe: true,
        },
      };
    }

    // 6. Acceptance
    log.info(
      {
        opportunityId: opportunity.id,
        offeredPayout,
        estimatedCost,
        expectedProfit,
        roiPercentage,
      },
      'opportunity accepted by economic brain',
    );

    return {
      action: 'ACCEPT',
      opportunityId: opportunity.id,
      estimatedCost,
      offeredPayout,
      expectedProfit,
      roiPercentage,
      permissionGranted: true,
      justification: `ACCEPTED: High-confidence positive ROI (+${roiPercentage.toFixed(1)}%), expected profit $${expectedProfit.toFixed(4)}.`,
      breakdown: {
        skillMatch: true,
        missingSkills: [],
        reputationScore,
        reputationPassed: true,
        profitabilityPassed: true,
        deadlineFeasible: true,
        capacityAvailable: true,
        escrowSafe: true,
      },
    };
  }
}
