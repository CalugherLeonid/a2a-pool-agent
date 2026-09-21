export interface MarketTask {
  id: string;
  source: string;
  prompt: string;
  maxBudgetAC: number;
  reputationRequired?: number;
}

export interface MarketAdapter {
  name: string;
  fetchAvailableTasks(): Promise<MarketTask[]>;
}

export class MultiMarketRouter {
  private adapters: MarketAdapter[] = [];

  public registerAdapter(adapter: MarketAdapter): void {
    this.adapters.push(adapter);
  }

  public async fetchAllTasks(): Promise<MarketTask[]> {
    const results = await Promise.allSettled(
      this.adapters.map((adapter) => adapter.fetchAvailableTasks())
    );

    const allTasks: MarketTask[] = [];

    for (const res of results) {
      if (res.status === 'fulfilled') {
        allTasks.push(...res.value);
      }
    }

    return allTasks;
  }
}