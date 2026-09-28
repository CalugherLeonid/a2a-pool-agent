import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OpportunityScanner } from '../opportunity/scanner.js';
import { EconomicBrain } from '../opportunity/economic-brain.js';
import { LocalFeedOpportunityAdapter } from '../opportunity/local-feed-adapter.js';
import type { Opportunity } from '../opportunity/types.js';

describe('OpportunityScanner - Continuous External Discovery & Ingestion', () => {
  let brain: EconomicBrain;
  let adapter: LocalFeedOpportunityAdapter;
  let scanner: OpportunityScanner;

  beforeEach(() => {
    brain = new EconomicBrain({
      capabilities: ['analysis', 'synthesis', 'verification'],
      minProfitMarginRatio: 0.20,
      minAbsoluteProfitUsd: 0.05,
    });
    adapter = new LocalFeedOpportunityAdapter();
    scanner = new OpportunityScanner({
      brain,
      adapters: [adapter],
      pollIntervalMs: 50,
    });
  });

  afterEach(() => {
    scanner.stop();
  });

  const sampleOpp1: Opportunity = {
    id: 'feed-opp-1',
    source: 'local-feed',
    title: 'Analyze order book imbalance',
    description: 'Provide order book imbalance ratio',
    payment: { amount: 0.25, currency: 'USDC', chain: 'solana' },
    deadline: new Date(Date.now() + 60000).toISOString(),
    skillsRequired: ['analysis'],
    discoveredAt: new Date().toISOString(),
  };

  const sampleOpp2: Opportunity = {
    id: 'feed-opp-2',
    source: 'local-feed',
    title: 'Arbitrage non-existent pool',
    description: 'Invalid skill request',
    payment: { amount: 0.50, currency: 'USDC', chain: 'solana' },
    deadline: new Date(Date.now() + 60000).toISOString(),
    skillsRequired: ['non-existent-skill'],
    discoveredAt: new Date().toISOString(),
  };

  it('polls opportunities from LocalFeedOpportunityAdapter and evaluates through EconomicBrain', async () => {
    adapter.pushOpportunity(sampleOpp1);
    adapter.pushOpportunity(sampleOpp2);

    expect(adapter.getPendingCount()).toBe(2);

    const evaluated = await scanner.scanAndEvaluate(0);

    expect(evaluated.length).toBe(2);

    // Opp 1 is accepted
    expect(evaluated[0]!.opportunity.id).toBe('feed-opp-1');
    expect(evaluated[0]!.decision.action).toBe('ACCEPT');
    expect(evaluated[0]!.decision.permissionGranted).toBe(true);

    // Opp 2 is rejected because agent lacks required skill
    expect(evaluated[1]!.opportunity.id).toBe('feed-opp-2');
    expect(evaluated[1]!.decision.action).toBe('REJECT');
    expect(evaluated[1]!.decision.permissionGranted).toBe(false);

    // Adapter queue is now drained
    expect(adapter.getPendingCount()).toBe(0);
  });

  it('deduplicates and does not re-process already evaluated opportunities', async () => {
    adapter.pushOpportunity(sampleOpp1);
    const firstPass = await scanner.scanAndEvaluate(0);
    expect(firstPass.length).toBe(1);

    // Pushing the same opportunity ID again
    adapter.pushOpportunity(sampleOpp1);
    const secondPass = await scanner.scanAndEvaluate(0);
    expect(secondPass.length).toBe(0);
  });

  it('triggers registered onDecision callbacks for each evaluated opportunity', async () => {
    const callback = vi.fn();
    scanner.onDecision(callback);

    adapter.pushOpportunity(sampleOpp1);
    await scanner.scanAndEvaluate(0);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      sampleOpp1,
      expect.objectContaining({ action: 'ACCEPT', permissionGranted: true }),
    );
  });

  it('manages background scanning lifecycle cleanly (start & stop)', async () => {
    expect(scanner.isRunning()).toBe(false);
    scanner.start();
    expect(scanner.isRunning()).toBe(true);
    scanner.stop();
    expect(scanner.isRunning()).toBe(false);
  });
});
