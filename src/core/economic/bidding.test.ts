import { describe, it, expect, beforeEach } from 'vitest';
import { BiddingEngine } from './bidding.js';
import { EconomicTracker } from './tracker.js';

describe('BiddingEngine - Dynamic Bidding & Margin Optimization', () => {
  let tracker: EconomicTracker;
  let engine: BiddingEngine;

  beforeEach(() => {
    tracker = new EconomicTracker();
    engine = new BiddingEngine(tracker, {
      baseMargin: 0.20,
      minMargin: 0.05,
      maxMargin: 0.80,
      reputationMultiplier: 0.15,
    });
  });

  it('calculează o ofertă standard cu marjă bază când istoricul este neutru', () => {
    const decision = engine.calculateOptimalBid({
      taskId: 't1',
      estimatedCost: 1.0,
      maxBudget: 2.0,
      reputationScore: 0.0,
    });

    expect(decision.shouldBid).toBe(true);
    expect(decision.bidAmount).toBe(1.20);
    expect(decision.expectedMargin).toBe(0.20);
  });

  it('scade marja automat când Win-Rate-ul scade sub 30%', () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordOutcome({
        taskId: `t_${i}`,
        provider: 'gemini',
        estimatedCost: 1.0,
        actualCost: 1.0,
        latencyMs: 200,
        won: i < 2,
        timestamp: Date.now(),
      });
    }

    const decision = engine.calculateOptimalBid({
      taskId: 't_low_wr',
      estimatedCost: 1.0,
      maxBudget: 2.0,
      reputationScore: 0.0,
    });

    expect(decision.shouldBid).toBe(true);
    expect(decision.bidAmount).toBe(1.10);
  });

  it('crește marja automat când Win-Rate-ul depășește 70%', () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordOutcome({
        taskId: `t_${i}`,
        provider: 'groq',
        estimatedCost: 1.0,
        actualCost: 1.0,
        latencyMs: 150,
        won: i < 8,
        timestamp: Date.now(),
      });
    }

    const decision = engine.calculateOptimalBid({
      taskId: 't_high_wr',
      estimatedCost: 1.0,
      maxBudget: 2.0,
      reputationScore: 0.0,
    });

    expect(decision.shouldBid).toBe(true);
    expect(decision.bidAmount).toBe(1.35);
  });

  it('aplică o primă de pret în funcție de scorul de reputație Ed25519', () => {
    const decision = engine.calculateOptimalBid({
      taskId: 't_rep',
      estimatedCost: 1.0,
      maxBudget: 2.0,
      reputationScore: 1.0,
    });

    expect(decision.shouldBid).toBe(true);
    expect(decision.bidAmount).toBe(1.35);
  });

  it('respinge licitația dacă costul estimat depășește bugetul oferit', () => {
    const decision = engine.calculateOptimalBid({
      taskId: 't_expensive',
      estimatedCost: 3.0,
      maxBudget: 2.5,
      reputationScore: 0.5,
    });

    expect(decision.shouldBid).toBe(false);
    expect(decision.reason).toContain('depășește bugetul maxim');
  });
});