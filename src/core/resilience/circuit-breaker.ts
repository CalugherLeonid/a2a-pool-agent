/**
 * Circuit Breaker Pattern Implementation for Production Resilience.
 *
 * Protects downstream providers (Gemini, Groq, OpenRouter) and A2A peers from cascading
 * failures by fast-failing calls when a service is degraded, and probing recovery in HALF_OPEN state.
 */

import { createLogger } from '../../observability/logger.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number; // default: 3 failures trips breaker
  resetTimeoutMs?: number; // default: 30000ms cooldown before HALF_OPEN probe
  halfOpenSuccessThreshold?: number; // default: 2 successful probes restores CLOSED
}

export class CircuitBreakerOpenError extends Error {
  constructor(public readonly circuitName: string, public readonly resetTimeoutMs: number) {
    super(`Circuit breaker '${circuitName}' is OPEN (cooling down for ${resetTimeoutMs}ms)`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  private readonly log = createLogger('circuit-breaker');
  public readonly name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenSuccessThreshold: number;

  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private consecutiveSuccesses = 0;
  private lastFailureTime = 0;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 2;
  }

  public getState(): CircuitState {
    this.updateStateIfCooldownElapsed();
    return this.state;
  }

  private updateStateIfCooldownElapsed(): void {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.consecutiveSuccesses = 0;
        this.log.info({ circuit: this.name }, 'circuit breaker transition: OPEN -> HALF_OPEN (probing)');
      }
    }
  }

  public canExecute(): boolean {
    const currentState = this.getState();
    return currentState === 'CLOSED' || currentState === 'HALF_OPEN';
  }

  public recordSuccess(): void {
    this.updateStateIfCooldownElapsed();

    if (this.state === 'HALF_OPEN') {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.halfOpenSuccessThreshold) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.consecutiveSuccesses = 0;
        this.log.info({ circuit: this.name }, 'circuit breaker transition: HALF_OPEN -> CLOSED (recovered)');
      }
    } else if (this.state === 'CLOSED') {
      // In CLOSED state, a success decrements failure count towards 0
      if (this.failureCount > 0) {
        this.failureCount = Math.max(0, this.failureCount - 1);
      }
    }
  }

  public recordFailure(err?: unknown): void {
    const errorMsg = err instanceof Error ? err.message : String(err);
    this.lastFailureTime = Date.now();

    if (this.state === 'CLOSED') {
      this.failureCount++;
      this.log.warn(
        { circuit: this.name, failures: this.failureCount, threshold: this.failureThreshold, error: errorMsg },
        'failure recorded in circuit breaker',
      );
      if (this.failureCount >= this.failureThreshold) {
        this.state = 'OPEN';
        this.log.error(
          { circuit: this.name, failures: this.failureCount, resetTimeoutMs: this.resetTimeoutMs },
          'circuit breaker tripped: CLOSED -> OPEN',
        );
      }
    } else if (this.state === 'HALF_OPEN') {
      // Any probe failure in HALF_OPEN immediately re-trips to OPEN
      this.state = 'OPEN';
      this.failureCount = this.failureThreshold;
      this.log.warn(
        { circuit: this.name, error: errorMsg },
        'probe failed in HALF_OPEN: immediately re-tripped to OPEN',
      );
    }
  }

  /**
   * Executes a protected asynchronous action within this circuit breaker.
   */
  public async execute<T>(action: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      throw new CircuitBreakerOpenError(this.name, this.resetTimeoutMs);
    }

    try {
      const result = await action();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err);
      throw err;
    }
  }

  public getStatus(): {
    name: string;
    state: CircuitState;
    failureCount: number;
    failureThreshold: number;
    consecutiveSuccesses: number;
    lastFailureTime: number;
    nextAttemptAllowedAt: number;
  } {
    const state = this.getState();
    const nextAttemptAllowedAt =
      state === 'OPEN' ? this.lastFailureTime + this.resetTimeoutMs : Date.now();

    return {
      name: this.name,
      state,
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
      consecutiveSuccesses: this.consecutiveSuccesses,
      lastFailureTime: this.lastFailureTime,
      nextAttemptAllowedAt,
    };
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.consecutiveSuccesses = 0;
    this.lastFailureTime = 0;
  }
}

/**
 * Registry for managing multiple named circuit breakers (LLM providers & A2A peers).
 */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly defaultOptions?: Partial<CircuitBreakerOptions>) {}

  public get(name: string, customOptions?: Partial<CircuitBreakerOptions>): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker({
        name,
        failureThreshold: customOptions?.failureThreshold ?? this.defaultOptions?.failureThreshold ?? 3,
        resetTimeoutMs: customOptions?.resetTimeoutMs ?? this.defaultOptions?.resetTimeoutMs ?? 30_000,
        halfOpenSuccessThreshold:
          customOptions?.halfOpenSuccessThreshold ?? this.defaultOptions?.halfOpenSuccessThreshold ?? 2,
      });
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  public getAll(): Map<string, CircuitBreaker> {
    return new Map(this.breakers);
  }

  public getAllStatuses(): Record<string, ReturnType<CircuitBreaker['getStatus']>> {
    const statuses: Record<string, ReturnType<CircuitBreaker['getStatus']>> = {};
    for (const [name, breaker] of this.breakers.entries()) {
      statuses[name] = breaker.getStatus();
    }
    return statuses;
  }

  public resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}
