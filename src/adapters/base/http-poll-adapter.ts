/**
 * Base class for adapters that talk to a REST marketplace via polling.
 *
 * Subclasses implement:
 *   - `fetchTasks()` - one poll cycle, returns new tasks
 *   - `doAccept()`, `doReject()`, `doDeliver()` - the actual platform calls
 *
 * The base class provides:
 *   - a resilient `poll()` loop with exponential backoff
 *   - health tracking
 *   - lifecycle management
 *
 * Subclasses MUST NOT override `poll()`, `accept()`, `reject()`, `deliver()`
 * unless the platform fundamentally needs different semantics (e.g. webhooks,
 * streaming). In that case, implement `MarketplaceAdapter` directly.
 */

import type { MarketplaceAdapter } from '../adapter.js';
import type {
  AcceptanceResult,
  AdapterCapabilities,
  AdapterConfig,
  AdapterCredentials,
  AdapterHealth,
  AdapterStatus,
  Delivery,
  RawTask,
  SettlementReceipt,
  Terms,
} from '../../core/types/index.js';
import { createLogger, type Logger } from '../../observability/logger.js';

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export abstract class HttpPollAdapter implements MarketplaceAdapter {
  abstract readonly id: string;
  abstract readonly displayName: string;

  protected readonly log: Logger;
  protected readonly pollIntervalMs: number;

  private running = false;
  private status: AdapterStatus = 'idle';
  private lastPollAt?: string;
  private lastErrorAt?: string;
  private lastError?: string;
  private backoffMs = BASE_BACKOFF_MS;

  constructor(
    protected readonly config: AdapterConfig,
    options: { pollIntervalMs?: number } = {},
  ) {
    this.log = createLogger('adapter:' + config.id);
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
  }

  // --- Abstract contract for subclasses --------------------------

  abstract capabilities(): AdapterCapabilities;

  /** One poll cycle. Return new tasks or an empty array. */
  protected abstract fetchTasks(): Promise<RawTask[]>;

  protected abstract doAccept(
    taskId: string,
    terms: Terms,
  ): Promise<AcceptanceResult>;

  protected abstract doReject(taskId: string, reason: string): Promise<void>;

  protected abstract doDeliver(
    taskId: string,
    result: Delivery,
  ): Promise<SettlementReceipt>;

  // --- MarketplaceAdapter implementation -------------------------

  async init(_credentials: AdapterCredentials): Promise<void> {
    this.status = 'idle';
    this.log.debug('initialized');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.status = 'stopped';
    this.log.debug('stopped');
  }

  health(): AdapterHealth {
    return {
      id: this.id,
      status: this.status,
      lastPollAt: this.lastPollAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      tasksInFlight: 0,
    };
  }

  async *poll(): AsyncIterable<RawTask> {
    this.running = true;
    this.status = 'polling';

    try {
      while (this.running) {
        try {
          this.lastPollAt = new Date().toISOString();
          const tasks = await this.fetchTasks();
          this.backoffMs = BASE_BACKOFF_MS;

          for (const task of tasks) {
            if (!this.running) return;
            yield task;
          }
        } catch (err) {
          this.recordError(err);
          this.increaseBackoff();
          await this.sleep(this.backoffMs);
          continue;
        }

        await this.sleep(this.pollIntervalMs);
      }
    } finally {
      this.running = false;
      if (this.status === 'polling') this.status = 'idle';
    }
  }

  async accept(taskId: string, terms: Terms): Promise<AcceptanceResult> {
    try {
      return await this.doAccept(taskId, terms);
    } catch (err) {
      this.recordError(err);
      throw err;
    }
  }

  async reject(taskId: string, reason: string): Promise<void> {
    try {
      await this.doReject(taskId, reason);
    } catch (err) {
      this.recordError(err);
      throw err;
    }
  }

  async deliver(taskId: string, result: Delivery): Promise<SettlementReceipt> {
    try {
      return await this.doDeliver(taskId, result);
    } catch (err) {
      this.recordError(err);
      throw err;
    }
  }

  // --- Helpers for subclasses ------------------------------------

  protected recordError(err: unknown): void {
    this.lastErrorAt = new Date().toISOString();
    this.lastError = err instanceof Error ? err.message : String(err);
    this.status = 'degraded';
    this.log.error({ err }, 'adapter error');
  }

  private increaseBackoff(): void {
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
