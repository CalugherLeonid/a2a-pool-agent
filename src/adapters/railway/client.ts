/**
 * HTTP client for the Railway a2a_pool platform.
 *
 * All requests are JSON over HTTPS. Uses native fetch (Node 22+).
 * Each request is bounded by a timeout via AbortController.
 *
 * The client is a thin transport: it does not decide, retry, or
 * interpret. That is Agent Core's job.
 */

import type {
  AcceptanceResult,
  Delivery,
  SettlementReceipt,
  Terms,
} from '../../core/types/index.js';
import type { RailwayTaskPayload } from './mapper.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export class RailwayClient {
  private readonly baseUrl: string;
  private readonly workerId: string;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    workerId: string,
    options: { timeoutMs?: number } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.workerId = workerId;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.baseUrl + path, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          'Railway HTTP ' + res.status + ': ' + (text || res.statusText),
        );
      }

      if (res.status === 204) {
        return undefined as T;
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Best-effort registration with the pool. */
  async register(pubkey?: string): Promise<void> {
    await this.request<unknown>('/register', {
      method: 'POST',
      body: JSON.stringify({
        worker_id: this.workerId,
        pubkey: pubkey ?? null,
      }),
    });
  }

  /**
   * Poll for new tasks. Tolerates three response shapes:
   *   - an array of tasks
   *   - an object with a `tasks` array
   *   - a single task object
   */
  async poll(): Promise<RailwayTaskPayload[]> {
    const res = await this.request<unknown>(
      '/poll?worker_id=' + encodeURIComponent(this.workerId),
      { method: 'GET' },
    );

    if (Array.isArray(res)) {
      return res as RailwayTaskPayload[];
    }

    if (res && typeof res === 'object') {
      const obj = res as Record<string, unknown>;
      if (Array.isArray(obj.tasks)) {
        return obj.tasks as RailwayTaskPayload[];
      }
      if (typeof obj.task_id === 'string') {
        return [obj as unknown as RailwayTaskPayload];
      }
    }

    return [];
  }

  async accept(taskId: string, terms: Terms): Promise<AcceptanceResult> {
    const res = await this.request<{
      accepted?: boolean;
      task_id?: string;
      locked_until?: string;
    }>('/accept', {
      method: 'POST',
      body: JSON.stringify({
        task_id: taskId,
        worker_id: this.workerId,
        est_cost_usd: terms.estimatedCostUsd,
        est_time_s: terms.estimatedTimeS,
        model: terms.model,
        confidence: terms.confidence,
        strategy_id: terms.strategyId,
      }),
    });

    return {
      accepted: res.accepted !== false,
      platformTaskId: res.task_id ?? taskId,
      lockedUntil:
        res.locked_until ?? new Date(Date.now() + 60_000).toISOString(),
      terms,
    };
  }

  async reject(taskId: string, reason: string): Promise<void> {
    await this.request<unknown>('/reject', {
      method: 'POST',
      body: JSON.stringify({
        task_id: taskId,
        worker_id: this.workerId,
        reason,
      }),
    });
  }

  async deliver(taskId: string, result: Delivery): Promise<SettlementReceipt> {
    const res = await this.request<{
      settled?: boolean;
      amount_usd?: number;
      tx_id?: string;
      status?: string;
    }>('/deliver', {
      method: 'POST',
      body: JSON.stringify({
        task_id: taskId,
        worker_id: this.workerId,
        output: result.output,
        hash: result.hash,
        sig: result.sig,
        meta: result.meta,
      }),
    });

    const amountUsd =
      typeof res.amount_usd === 'number' ? res.amount_usd : 0;
    const settled = res.settled !== false;

    return {
      taskId,
      adapterId: 'railway',
      currency: 'INTERNAL',
      amount: amountUsd,
      amountUsd,
      platformFeePct: 0,
      platformFeeAmount: 0,
      netAmount: amountUsd,
      netAmountUsd: amountUsd,
      internalId: res.tx_id,
      status: settled ? 'settled' : 'pending',
      settledAt: settled ? new Date().toISOString() : undefined,
    };
  }

  async heartbeat(payload: Record<string, unknown>): Promise<void> {
    await this.request<unknown>('/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ worker_id: this.workerId, ...payload }),
    });
  }
}
