/**
 * Dynamic Pricing Strategy based on Agent Reputation and Performance.
 *
 * Configurable rules for adjusting pricing in the Agent Card:
 * - High reputation (> 0.90): may increase price by up to maxIncreasePercent (e.g. +10%)
 * - Low reputation (< 0.50): discounts price by up to maxDiscountPercent (e.g. -15%)
 * - Moderate reputation (0.50 - 0.90): baseline pricing with smooth interpolation
 * - Preserves minimum price floor (minFloorUsd) and maximum price ceiling (maxCeilingUsd)
 */

export interface DynamicPricingConfig {
  basePriceUsd: number;
  baseMinRewardUsd: number;
  highReputationThreshold?: number; // default: 0.90
  lowReputationThreshold?: number; // default: 0.50
  maxIncreasePercent?: number; // default: 0.10 (+10%)
  maxDiscountPercent?: number; // default: 0.15 (-15%)
  minFloorUsd?: number; // default: 0.01
  maxCeilingUsd?: number; // default: 10.00
}

export interface CalculatedPricing {
  defaultCostUsd: number;
  minAcceptedRewardUsd: number;
  multiplier: number;
  reason: string;
}

export class DynamicPricingEngine {
  private config: Required<DynamicPricingConfig>;

  constructor(config: DynamicPricingConfig) {
    this.config = {
      basePriceUsd: config.basePriceUsd,
      baseMinRewardUsd: config.baseMinRewardUsd,
      highReputationThreshold: config.highReputationThreshold ?? 0.90,
      lowReputationThreshold: config.lowReputationThreshold ?? 0.50,
      maxIncreasePercent: config.maxIncreasePercent ?? 0.10,
      maxDiscountPercent: config.maxDiscountPercent ?? 0.15,
      minFloorUsd: config.minFloorUsd ?? 0.01,
      maxCeilingUsd: config.maxCeilingUsd ?? 10.00,
    };
  }

  /**
   * Calculates dynamic price based on reputation score [0.0, 1.0].
   */
  public calculatePricing(reputationScore: number): CalculatedPricing {
    const clampedRep = Math.max(0.0, Math.min(1.0, reputationScore));
    let multiplier = 1.0;
    let reason = 'baseline';

    if (clampedRep >= this.config.highReputationThreshold) {
      // Scale linearly between high threshold and 1.0 up to maxIncreasePercent
      const span = 1.0 - this.config.highReputationThreshold;
      const progress = span > 0 ? (clampedRep - this.config.highReputationThreshold) / span : 1.0;
      multiplier = 1.0 + progress * this.config.maxIncreasePercent;
      reason = `high_reputation_premium (+${((multiplier - 1.0) * 100).toFixed(1)}%)`;
    } else if (clampedRep < this.config.lowReputationThreshold) {
      // Scale discount between 0.0 and low threshold down by maxDiscountPercent
      const progress =
        this.config.lowReputationThreshold > 0
          ? (this.config.lowReputationThreshold - clampedRep) / this.config.lowReputationThreshold
          : 1.0;
      multiplier = 1.0 - progress * this.config.maxDiscountPercent;
      reason = `low_reputation_discount (-${((1.0 - multiplier) * 100).toFixed(1)}%)`;
    } else {
      multiplier = 1.0;
      reason = 'nominal_reputation_standard';
    }

    const rawCost = this.config.basePriceUsd * multiplier;
    const rawReward = this.config.baseMinRewardUsd * multiplier;

    const defaultCostUsd = parseFloat(
      Math.max(this.config.minFloorUsd, Math.min(this.config.maxCeilingUsd, rawCost)).toFixed(4),
    );
    const minAcceptedRewardUsd = parseFloat(
      Math.max(this.config.minFloorUsd, Math.min(this.config.maxCeilingUsd, rawReward)).toFixed(4),
    );

    return {
      defaultCostUsd,
      minAcceptedRewardUsd,
      multiplier: parseFloat(multiplier.toFixed(4)),
      reason,
    };
  }

  public updateBasePrices(basePriceUsd: number, baseMinRewardUsd?: number): void {
    this.config.basePriceUsd = basePriceUsd;
    if (baseMinRewardUsd !== undefined) {
      this.config.baseMinRewardUsd = baseMinRewardUsd;
    }
  }

  public updateRules(rules: Partial<DynamicPricingConfig>): void {
    if (rules.basePriceUsd !== undefined) this.config.basePriceUsd = rules.basePriceUsd;
    if (rules.baseMinRewardUsd !== undefined) this.config.baseMinRewardUsd = rules.baseMinRewardUsd;
    if (rules.highReputationThreshold !== undefined) this.config.highReputationThreshold = rules.highReputationThreshold;
    if (rules.lowReputationThreshold !== undefined) this.config.lowReputationThreshold = rules.lowReputationThreshold;
    if (rules.maxIncreasePercent !== undefined) this.config.maxIncreasePercent = rules.maxIncreasePercent;
    if (rules.maxDiscountPercent !== undefined) this.config.maxDiscountPercent = rules.maxDiscountPercent;
    if (rules.minFloorUsd !== undefined) this.config.minFloorUsd = rules.minFloorUsd;
    if (rules.maxCeilingUsd !== undefined) this.config.maxCeilingUsd = rules.maxCeilingUsd;
  }

  public getConfig(): Required<DynamicPricingConfig> {
    return { ...this.config };
  }
}
