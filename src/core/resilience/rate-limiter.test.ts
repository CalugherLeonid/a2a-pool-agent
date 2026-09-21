import { describe, it, expect } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter - Token Bucket Resilience', () => {
  it('permite consumul de token-uri în limita capacității', () => {
    const limiter = new RateLimiter(5, 1);
    expect(limiter.tryConsume(3)).toBe(true);
    expect(limiter.tryConsume(2)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(false);
  });

  it('raportează corect numărul de token-uri disponibile', () => {
    const limiter = new RateLimiter(10, 2);
    expect(limiter.getAvailableTokens()).toBe(10);
    limiter.tryConsume(4);
    expect(limiter.getAvailableTokens()).toBe(6);
  });
});