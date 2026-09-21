import { describe, it, expect } from 'vitest';
import { shouldAcceptTask, TaskRejectedError } from './triage.js';
import {
  estimateCostByTokens,
  estimateCostFromPromptText,
  getDetailedCostBreakdown,
} from './cost-estimator.js';

describe('Cost Estimator', () => {
  it('calculates cost based on token count and model', () => {
    // gemini-1.5-flash: 0.075 / 1M in, 0.30 / 1M out (default 500 tokens)
    const cost = estimateCostByTokens(1000, 'gemini-1.5-flash', 500);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(0.000225, 5);
  });

  it('estimates cost from prompt text', () => {
    const text = 'Explain quantum computing in 200 words.';
    const cost = estimateCostFromPromptText(text, 'gemini-1.5-flash');
    expect(cost).toBeGreaterThan(0);
  });

  it('returns detailed breakdown', () => {
    const breakdown = getDetailedCostBreakdown(2000, 'llama-3.3-70b-versatile', 1000);
    expect(breakdown.inputCostUsd).toBeGreaterThan(0);
    expect(breakdown.outputCostUsd).toBeGreaterThan(0);
    expect(breakdown.totalCostUsd).toBe(
      Number((breakdown.inputCostUsd + breakdown.outputCostUsd).toFixed(6)),
    );
  });
});

describe('Economics Triage (shouldAcceptTask)', () => {
  it('accepts tasks with positive EV and successProbability >= 0.7', () => {
    const reward = 1.0; // $1.00
    const successProbability = 0.85; // 85%
    const estimatedCost = 0.05; // $0.05
    // EV = (1.0 * 0.85) - 0.05 = 0.80 > 0

    const decision = shouldAcceptTask(reward, successProbability, estimatedCost);
    expect(decision.accepted).toBe(true);
    expect(decision.ev).toBe(0.8);
  });

  it('throws TaskRejectedError when successProbability < 0.7', () => {
    const reward = 100.0;
    const successProbability = 0.69; // below 0.7 threshold
    const estimatedCost = 0.01;

    expect(() => shouldAcceptTask(reward, successProbability, estimatedCost)).toThrowError(
      TaskRejectedError,
    );

    try {
      shouldAcceptTask(reward, successProbability, estimatedCost);
    } catch (err) {
      const e = err as TaskRejectedError;
      expect(e.reason).toBe('PROBABILITY_TOO_LOW');
      expect(e.successProbability).toBe(0.69);
    }
  });

  it('throws TaskRejectedError when Expected Value is negative', () => {
    const reward = 0.10; // $0.10
    const successProbability = 0.80; // 80%
    const estimatedCost = 0.15; // $0.15
    // EV = (0.10 * 0.8) - 0.15 = 0.08 - 0.15 = -0.07 <= 0

    expect(() => shouldAcceptTask(reward, successProbability, estimatedCost)).toThrowError(
      TaskRejectedError,
    );

    try {
      shouldAcceptTask(reward, successProbability, estimatedCost);
    } catch (err) {
      const e = err as TaskRejectedError;
      expect(e.reason).toBe('NEGATIVE_EXPECTED_VALUE');
      expect(e.ev).toBe(-0.07);
    }
  });

  it('throws TaskRejectedError when EV is exactly zero', () => {
    const reward = 1.0;
    const successProbability = 1.0;
    const estimatedCost = 1.0;
    // EV = 0

    expect(() => shouldAcceptTask(reward, successProbability, estimatedCost)).toThrowError(
      TaskRejectedError,
    );
  });
});
