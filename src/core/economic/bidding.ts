import { EconomicTracker } from './tracker.js';

export interface BiddingStrategyConfig {
  baseMargin: number;
  minMargin: number;
  maxMargin: number;
  reputationMultiplier: number;
}

export interface BidRequest {
  taskId: string;
  estimatedCost: number;
  maxBudget: number;
  reputationScore: number;
}

export interface BidDecision {
  shouldBid: boolean;
  bidAmount: number;
  estimatedCost: number;
  expectedMargin: number;
  reason?: string;
}

export class BiddingEngine {
  private config: BiddingStrategyConfig;

  constructor(
    private tracker: EconomicTracker,
    config?: Partial<BiddingStrategyConfig>
  ) {
    this.config = {
      baseMargin: 0.20,
      minMargin: 0.05,
      maxMargin: 0.80,
      reputationMultiplier: 0.15,
      ...config,
    };
  }

  public calculateOptimalBid(request: BidRequest): BidDecision {
    const { estimatedCost, maxBudget, reputationScore } = request;

    const adjustedCost = estimatedCost * this.tracker.getCostAccuracyRatio();

    if (adjustedCost >= maxBudget) {
      return {
        shouldBid: false,
        bidAmount: 0,
        estimatedCost: Number(adjustedCost.toFixed(4)),
        expectedMargin: 0,
        reason: `Costul ajustat (${adjustedCost.toFixed(4)}) depășește bugetul maxim (${maxBudget}).`,
      };
    }

    const winRate = this.tracker.getWinRate();

    let marginAdjustment = 0;
    if (winRate < 0.30) {
      marginAdjustment = -0.10;
    } else if (winRate > 0.70) {
      marginAdjustment = 0.15;
    }

    const reputationBonus = Math.min(1, Math.max(0, reputationScore)) * this.config.reputationMultiplier;

    let targetMargin = this.config.baseMargin + marginAdjustment + reputationBonus;
    targetMargin = Math.max(
      this.config.minMargin,
      Math.min(this.config.maxMargin, targetMargin)
    );

    let proposedBid = adjustedCost * (1 + targetMargin);

    if (proposedBid > maxBudget) {
      proposedBid = maxBudget;
    }

    const effectiveMargin = (proposedBid - adjustedCost) / adjustedCost;

    if (effectiveMargin < this.config.minMargin) {
      return {
        shouldBid: false,
        bidAmount: 0,
        estimatedCost: Number(adjustedCost.toFixed(4)),
        expectedMargin: Number(effectiveMargin.toFixed(4)),
        reason: `Marja efectivă (${(effectiveMargin * 100).toFixed(1)}%) este sub pragul minim permis (${(this.config.minMargin * 100).toFixed(1)}%).`,
      };
    }

    return {
      shouldBid: true,
      bidAmount: Number(proposedBid.toFixed(4)),
      estimatedCost: Number(adjustedCost.toFixed(4)),
      expectedMargin: Number(effectiveMargin.toFixed(4)),
    };
  }
}