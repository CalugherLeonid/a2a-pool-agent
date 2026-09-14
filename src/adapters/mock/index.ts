/**
 * Mock adapter.
 *
 * Emits a small number of synthetic tasks per poll cycle. Used during
 * development to exercise the full Agent Core loop without depending
 * on an external platform.
 *
 * Behavior is deterministic: no randomness, no external calls.
 */

import { HttpPollAdapter } from '../base/http-poll-adapter.js';
import type {
  AcceptanceResult,
  AdapterCapabilities,
  AdapterConfig,
  Delivery,
  RawTask,
  SettlementReceipt,
  Terms,
} from '../../core/types/index.js';
import { MockTaskGenerator } from './task-generator.js';
import { getCapabilities } from './capabilities.js';

interface MockCredentials {
  tasksPerCycle?: number;
  taskPoolSize?: number;
}

export class MockAdapter extends HttpPollAdapter {
  readonly id = 'mock';
  readonly displayName = 'Mock Marketplace (Local)';

  private readonly generator: MockTaskGenerator;
  private readonly tasksPerCycle: number;

  constructor(
    config: AdapterConfig,
    options: { pollIntervalMs?: number } = {},
  ) {
    super(config, options);

    const creds = (config.credentials ?? {}) as MockCredentials;
    this.tasksPerCycle = creds.tasksPerCycle ?? 1;

    this.generator = new MockTaskGenerator({
      taskPoolSize: creds.taskPoolSize ?? 4,
      idPrefix: 'mock',
    });
  }

  capabilities(): AdapterCapabilities {
    return getCapabilities();
  }

  protected async fetchTasks(): Promise<RawTask[]> {
    const tasks: RawTask[] = [];
    for (let i = 0; i < this.tasksPerCycle; i += 1) {
      tasks.push(this.generator.next());
    }
    return tasks;
  }

  protected async doAccept(
    taskId: string,
    terms: Terms,
  ): Promise<AcceptanceResult> {
    this.log.debug({ taskId, terms }, 'mock accept');
    return {
      accepted: true,
      platformTaskId: taskId,
      lockedUntil: new Date(Date.now() + 60_000).toISOString(),
      terms,
    };
  }

  protected async doReject(taskId: string, reason: string): Promise<void> {
    this.log.debug({ taskId, reason }, 'mock reject');
  }

  protected async doDeliver(
    taskId: string,
    result: Delivery,
  ): Promise<SettlementReceipt> {
    this.log.debug({ taskId, hash: result.hash }, 'mock deliver');

    const amountUsd = 1.0;
    return {
      taskId,
      adapterId: 'mock',
      currency: 'INTERNAL',
      amount: amountUsd,
      amountUsd,
      platformFeePct: 0,
      platformFeeAmount: 0,
      netAmount: amountUsd,
      netAmountUsd: amountUsd,
      status: 'settled',
      settledAt: new Date().toISOString(),
    };
  }
}
