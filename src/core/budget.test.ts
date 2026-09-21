import { describe, it, expect, vi } from 'vitest';
import { BudgetGuard } from './budget.js';
import type { LearningStore } from './learning.js';

describe('BudgetGuard', () => {
  const mockStore = {
    costToday: vi.fn().mockResolvedValue(1.5),
  } as unknown as LearningStore;

  it('initializes with zero used spend before hydrate', () => {
    const budget = new BudgetGuard({ dailyCapUsd: 10, store: mockStore });
    expect(budget.used).toBe(0);
    expect(budget.cap).toBe(10);
    expect(budget.remaining).toBe(10);
    expect(budget.isExhausted()).toBe(false);
  });

  it('hydrates today spend from store', async () => {
    const budget = new BudgetGuard({ dailyCapUsd: 5, store: mockStore });
    await budget.hydrate();
    expect(budget.used).toBe(1.5);
    expect(budget.remaining).toBe(3.5);
  });

  it('correctly checks wouldExceed', () => {
    const budget = new BudgetGuard({ dailyCapUsd: 2, store: mockStore });
    budget.record(1.2);
    expect(budget.wouldExceed(0.5)).toBe(false);
    expect(budget.wouldExceed(0.9)).toBe(true);
  });

  it('exhausts when used reaches or exceeds cap', () => {
    const budget = new BudgetGuard({ dailyCapUsd: 2, store: mockStore });
    budget.record(2.0);
    expect(budget.isExhausted()).toBe(true);
    expect(budget.remaining).toBe(0);
  });
});
