import type {
  AcceptanceResult,
  AdapterCapabilities,
  AdapterCredentials,
  AdapterHealth,
  Delivery,
  NegotiationResult,
  RawTask,
  SettlementReceipt,
  Terms,
} from '../core/types/index.js';

/**
 * The contract every marketplace adapter must fulfil.
 *
 * Agent Core knows nothing about Railway, OKX, Clustly, or any other
 * platform. It only knows this interface. Adding a new marketplace means
 * writing a new class that implements `MarketplaceAdapter` — nothing else.
 *
 * Design rules:
 *  1. `poll()` is a pull-based async iterable. Core decides how to consume.
 *  2. `accept()` MUST acquire the platform's lock before returning
 *     `accepted: true`. No side-effects after returning.
 *  3. `deliver()` MUST be idempotent — Core may retry on transient errors.
 *  4. `reject()` MUST be safe to call even if the task has already expired.
 *  5. Adapters MUST NOT contain business logic. No cost decisions, no model
 *     selection, no retry policy. Those live in Core.
 */
export interface MarketplaceAdapter {
  /** Stable identifier, e.g. "railway", "okx", "clustly". */
  readonly id: string;

  /** Human-readable name for logs and dashboards. */
  readonly displayName: string;

  /** Declarative description of what this adapter can do and requires. */
  capabilities(): AdapterCapabilities;

  /** Initialize the adapter. Called once at startup. */
  init(credentials: AdapterCredentials): Promise<void>;

  /** Stop the adapter, releasing resources. Called on shutdown. */
  stop(): Promise<void>;

  /** Current health, for observability. */
  health(): AdapterHealth;

  /**
   * Yield new tasks as they appear.
   *
   * Core iterates this stream and decides what to do with each. Implementations
   * should back off internally on rate limits and resume automatically.
   */
  poll(): AsyncIterable<RawTask>;

  /**
   * Accept a task with the given terms.
   * Must acquire the platform's lock before returning `accepted: true`.
   */
  accept(taskId: string, terms: Terms): Promise<AcceptanceResult>;

  /** Reject a task. Must be idempotent and safe to call at any time. */
  reject(taskId: string, reason: string): Promise<void>;

  /** Deliver the result of a task. Must be idempotent — Core may retry. */
  deliver(taskId: string, result: Delivery): Promise<SettlementReceipt>;

  /**
   * Optional. Only implemented by adapters whose
   * `capabilities().supports.negotiation` is `true`.
   */
  negotiate?(taskId: string, terms: Terms): Promise<NegotiationResult>;

  /**
   * Optional. Only implemented by adapters whose platform exposes a
   * dispute mechanism.
   */
  dispute?(taskId: string, reason: string): Promise<void>;
}