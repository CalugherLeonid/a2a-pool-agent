/**
 * Local Feed Opportunity Source Adapter.
 *
 * Provides a clean adapter for feeding structured opportunities from
 * local queues, files, or direct testing sources without any simulated payments.
 */

import type { Opportunity, OpportunitySourceAdapter } from './types.js';

export class LocalFeedOpportunityAdapter implements OpportunitySourceAdapter {
  public readonly id = 'local-feed';
  private queue: Opportunity[] = [];

  constructor(initialOpportunities?: Opportunity[]) {
    if (initialOpportunities) {
      this.queue.push(...initialOpportunities);
    }
  }

  public pushOpportunity(opportunity: Opportunity): void {
    this.queue.push(opportunity);
  }

  public pushOpportunities(opportunities: Opportunity[]): void {
    this.queue.push(...opportunities);
  }

  public async pollOpportunities(): Promise<Opportunity[]> {
    if (this.queue.length === 0) {
      return [];
    }
    const polled = [...this.queue];
    this.queue = [];
    return polled;
  }

  public getPendingCount(): number {
    return this.queue.length;
  }

  public clear(): void {
    this.queue = [];
  }
}
