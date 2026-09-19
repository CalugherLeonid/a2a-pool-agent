/**
 * Railway adapter.
 *
 * Extends HttpPollAdapter, which provides the resilient polling loop
 * and health tracking. The adapter receives the agent's Signer at
 * construction time and uses it to publish the Ed25519 public key
 * when registering with the pool.
 */

import { HttpPollAdapter } from '../base/http-poll-adapter.js';
import type {
  AcceptanceResult,
  AdapterCapabilities,
  AdapterConfig,
  AdapterCredentials,
  Delivery,
  RawTask,
  SettlementReceipt,
  Terms,
} from '../../core/types/index.js';
import type { Signer } from '../../identity/ed25519.js';
import { env } from '../../config/env.js';
import { RailwayClient } from './client.js';
import { mapRailwayTask } from './mapper.js';
import { getCapabilities } from './capabilities.js';

export class RailwayAdapter extends HttpPollAdapter {
  readonly id = 'railway';
  readonly displayName = 'A2A Pool (Railway)';

  private client?: RailwayClient;

  constructor(
    config: AdapterConfig,
    private readonly signer: Signer,
    options: { pollIntervalMs?: number } = {},
  ) {
    super(config, options);
  }

  capabilities(): AdapterCapabilities {
    return getCapabilities();
  }

  override async init(_credentials: AdapterCredentials): Promise<void> {
    await super.init(_credentials);

    const url = env.RAILWAY_POOL_URL;
    const workerId = env.RAILWAY_WORKER_ID;

    if (!url || !workerId) {
      this.log.warn(
        'RAILWAY_POOL_URL or RAILWAY_WORKER_ID not set — adapter will not poll',
      );
      return;
    }

    this.client = new RailwayClient(url, workerId);

    const pubkey = this.signer.pubkeyPem();
    const pubkeyFirstLine = pubkey.split('\n')[0] ?? '';

    try {
      await this.client.register(pubkey);
      this.log.info(
        { url, workerId, pubkey: pubkeyFirstLine },
        'registered with Railway pool (pubkey sent)',
      );
    } catch (err) {
      this.log.warn(
        { err },
        'register failed (best-effort, continuing)',
      );
    }
  }

  protected async fetchTasks(): Promise<RawTask[]> {
    if (!this.client) return [];
    const payloads = await this.client.poll();
    return payloads.map(mapRailwayTask);
  }

  protected async doAccept(
    taskId: string,
    terms: Terms,
  ): Promise<AcceptanceResult> {
    if (!this.client) throw new Error('Railway adapter not initialized');
    return this.client.accept(taskId, terms);
  }

  protected async doReject(taskId: string, reason: string): Promise<void> {
    if (!this.client) throw new Error('Railway adapter not initialized');
    return this.client.reject(taskId, reason);
  }

  protected async doDeliver(
    taskId: string,
    result: Delivery,
  ): Promise<SettlementReceipt> {
    if (!this.client) throw new Error('Railway adapter not initialized');
    return this.client.deliver(taskId, result);
  }
}
