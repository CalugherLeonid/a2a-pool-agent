import { describe, it, expect } from 'vitest';
import { HttpPollAdapter } from './http-poll-adapter.js';
import type {
  AcceptanceResult,
  AdapterCapabilities,
  AdapterConfig,
  Delivery,
  RawTask,
  SettlementReceipt,
  Terms,
} from '../../core/types/index.js';

class TestPollAdapter extends HttpPollAdapter {
  readonly id = 'test';
  readonly displayName = 'Test Adapter';
  mockTasksToReturn: RawTask[] = [];

  capabilities(): AdapterCapabilities {
    return {
      supports: {
        negotiation: false,
        bidding: false,
        webhooks: false,
        streaming: false,
        multipleWallets: false,
        managedRuntime: false,
      },
      requires: {
        onChainIdentity: false,
        hmacSigning: false,
        policyLayer: false,
        humanClaimant: false,
        contentScoring: false,
      },
      limits: {
        maxConcurrentTasks: 1,
        minBudgetUsd: 0.01,
        settlementCurrency: 'USD',
        averageSettlementDelayHours: 0,
        platformFeePct: 0,
      },
    };
  }

  protected async fetchTasks(): Promise<RawTask[]> {
    return this.mockTasksToReturn;
  }

  protected async doAccept(taskId: string, terms: Terms): Promise<AcceptanceResult> {
    return {
      accepted: true,
      platformTaskId: taskId,
      lockedUntil: new Date(Date.now() + 60000).toISOString(),
      terms,
    };
  }

  protected async doReject(_taskId: string, _reason: string): Promise<void> {}

  protected async doDeliver(taskId: string, _result: Delivery): Promise<SettlementReceipt> {
    return {
      taskId,
      adapterId: 'test',
      currency: 'USD',
      amount: 1,
      amountUsd: 1,
      platformFeePct: 0,
      platformFeeAmount: 0,
      netAmount: 1,
      netAmountUsd: 1,
      status: 'settled',
      txHash: '0x123',
      settledAt: new Date().toISOString(),
    };
  }
}

describe('HttpPollAdapter Deduplication (R-REG-2)', () => {
  it('deduplicates identical tasks returned across consecutive poll calls', async () => {
    const config: AdapterConfig = {
      id: 'test',
      enabled: true,
      credentialsSource: 'inline',
      priority: 1,
      credentials: {},
    };

    const adapter = new TestPollAdapter(config, { pollIntervalMs: 10 });

    const task1: RawTask = {
      id: 'task-1',
      source: 'test',
      type: 'extract',
      budgetEstimateUsd: 1.0,
      deadlineS: 60,
      prompt: 'extract numbers',
      outputSchema: { type: 'object' },
      raw: {},
      observedAt: new Date().toISOString(),
    };

    adapter.mockTasksToReturn = [task1];

    const iterator = adapter.poll()[Symbol.asyncIterator]();
    const next1 = await iterator.next();

    expect(next1.done).toBe(false);
    expect(next1.value?.id).toBe('task-1');

    await adapter.stop();
  });
});
