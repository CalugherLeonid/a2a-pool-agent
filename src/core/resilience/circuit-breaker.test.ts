import { describe, it, expect, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerRegistry,
} from './circuit-breaker.js';

describe('CircuitBreaker - Resilience & Cascading Failure Protection', () => {
  it('începe în starea CLOSED și permite execuția', async () => {
    const cb = new CircuitBreaker({ name: 'gemini-provider', failureThreshold: 3 });
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.canExecute()).toBe(true);

    const result = await cb.execute(async () => 'hello');
    expect(result).toBe('hello');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('trece în OPEN după depășirea pragului de eșecuri consecutive', async () => {
    const cb = new CircuitBreaker({
      name: 'failing-peer',
      failureThreshold: 2,
      resetTimeoutMs: 10_000,
    });

    // Primul eșec
    await expect(
      cb.execute(async () => {
        throw new Error('500 internal error');
      }),
    ).rejects.toThrow('500 internal error');
    expect(cb.getState()).toBe('CLOSED');

    // Al doilea eșec -> deschide circuitul
    await expect(
      cb.execute(async () => {
        throw new Error('503 unavailable');
      }),
    ).rejects.toThrow('503 unavailable');
    expect(cb.getState()).toBe('OPEN');
    expect(cb.canExecute()).toBe(false);

    // Apelurile ulterioare fast-fail cu CircuitBreakerOpenError
    await expect(cb.execute(async () => 'never called')).rejects.toThrow(
      CircuitBreakerOpenError,
    );
  });

  it('trece în HALF_OPEN după expirarea cooldown-ului și revine în CLOSED după succese', async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker({
        name: 'test-cooldown',
        failureThreshold: 1,
        resetTimeoutMs: 5000,
        halfOpenSuccessThreshold: 2,
      });

      // Eșuează și trece în OPEN
      cb.recordFailure(new Error('timeout'));
      expect(cb.getState()).toBe('OPEN');

      // Înainte de cooldown, rămâne OPEN
      vi.advanceTimersByTime(2000);
      expect(cb.getState()).toBe('OPEN');

      // După cooldown, trece în HALF_OPEN
      vi.advanceTimersByTime(3001);
      expect(cb.getState()).toBe('HALF_OPEN');

      // Primul succes în HALF_OPEN -> rămâne HALF_OPEN (are nevoie de 2)
      cb.recordSuccess();
      expect(cb.getState()).toBe('HALF_OPEN');

      // Al doilea succes -> revine în CLOSED
      cb.recordSuccess();
      expect(cb.getState()).toBe('CLOSED');
      expect(cb.canExecute()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-deschide imediat circuitul dacă proba eșuează în HALF_OPEN', () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker({
        name: 'probe-fail',
        failureThreshold: 1,
        resetTimeoutMs: 3000,
      });

      cb.recordFailure(new Error('first fail'));
      expect(cb.getState()).toBe('OPEN');

      vi.advanceTimersByTime(3001);
      expect(cb.getState()).toBe('HALF_OPEN');

      // Eșec în probă
      cb.recordFailure(new Error('probe failed'));
      expect(cb.getState()).toBe('OPEN');
    } finally {
      vi.useRealTimers();
    }
  });

  it('CircuitBreakerRegistry gestionează instanțe multiple pe provideri și peer-i', () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 3 });

    const geminiBreaker = registry.get('provider:gemini');
    const groqBreaker = registry.get('provider:groq');
    const peerBreaker = registry.get('peer:agent-bob');

    expect(geminiBreaker).toBeDefined();
    expect(groqBreaker).toBeDefined();
    expect(peerBreaker).toBeDefined();
    expect(geminiBreaker).not.toBe(groqBreaker);

    // Verifică că readuce aceeași instanță
    expect(registry.get('provider:gemini')).toBe(geminiBreaker);

    const statuses = registry.getAllStatuses();
    expect(statuses['provider:gemini']?.state).toBe('CLOSED');
    expect(statuses['peer:agent-bob']?.failureThreshold).toBe(3);
  });
});
