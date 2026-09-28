import { describe, it, expect } from 'vitest';
import { GranularRateLimiter } from './granular-rate-limiter.js';

describe('GranularRateLimiter - Multi-Tier Rate Limiting', () => {
  it('impune limita globală de consum', () => {
    const limiter = new GranularRateLimiter({
      global: { limitPerMinute: 60, maxTokens: 2, refillRatePerSec: 0 },
    });

    expect(limiter.tryConsume({ tokens: 1 }).allowed).toBe(true);
    expect(limiter.tryConsume({ tokens: 1 }).allowed).toBe(true);
    const rejected = limiter.tryConsume({ tokens: 1 });
    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toBe('global_rate_limit_exceeded');
  });

  it('izolează limitele per-peer pentru a preveni monopolizarea resurselor de un vecin zgomotos', () => {
    const limiter = new GranularRateLimiter({
      global: { limitPerMinute: 100, maxTokens: 20, refillRatePerSec: 0 },
      peerDefaults: { limitPerMinute: 20, maxTokens: 2, refillRatePerSec: 0 },
    });

    // Peer Alice consumă cota ei
    expect(limiter.tryConsume({ peerId: 'peer-alice', tokens: 1 }).allowed).toBe(true);
    expect(limiter.tryConsume({ peerId: 'peer-alice', tokens: 1 }).allowed).toBe(true);

    // Alice depășește limita
    const aliceBlocked = limiter.tryConsume({ peerId: 'peer-alice', tokens: 1 });
    expect(aliceBlocked.allowed).toBe(false);
    expect(aliceBlocked.reason).toBe('peer_rate_limit_exceeded:peer-alice');

    // Peer Bob este neafectat și poate consuma normal
    const bobAllowed = limiter.tryConsume({ peerId: 'peer-bob', tokens: 1 });
    expect(bobAllowed.allowed).toBe(true);
  });

  it('izolează limitele per-skill pentru a proteja unelte costisitoare computațional', () => {
    const limiter = new GranularRateLimiter({
      global: { limitPerMinute: 100, maxTokens: 20, refillRatePerSec: 0 },
      skillDefaults: { limitPerMinute: 10, maxTokens: 1, refillRatePerSec: 0 },
    });

    // Heavy tool consumat o dată
    expect(limiter.tryConsume({ skillId: 'heavy-matrix-calc', tokens: 1 }).allowed).toBe(true);

    // A doua oară este blocat
    const heavyBlocked = limiter.tryConsume({ skillId: 'heavy-matrix-calc', tokens: 1 });
    expect(heavyBlocked.allowed).toBe(false);
    expect(heavyBlocked.reason).toBe('skill_rate_limit_exceeded:heavy-matrix-calc');

    // Un alt tool ușor este permis
    const lightAllowed = limiter.tryConsume({ skillId: 'simple-hash', tokens: 1 });
    expect(lightAllowed.allowed).toBe(true);
  });

  it('suportă configurări specifice (overrides) per-peer sau per-skill', () => {
    const limiter = new GranularRateLimiter({
      global: { limitPerMinute: 100, maxTokens: 50, refillRatePerSec: 0 },
      peerDefaults: { limitPerMinute: 10, maxTokens: 1, refillRatePerSec: 0 },
      peerOverrides: {
        'trusted-partner': { limitPerMinute: 100, maxTokens: 10, refillRatePerSec: 0 },
      },
    });

    // Un peer standard are maxTokens: 1
    expect(limiter.tryConsume({ peerId: 'random-peer', tokens: 1 }).allowed).toBe(true);
    expect(limiter.tryConsume({ peerId: 'random-peer', tokens: 1 }).allowed).toBe(false);

    // Trusted partner are override cu maxTokens: 10
    expect(limiter.tryConsume({ peerId: 'trusted-partner', tokens: 5 }).allowed).toBe(true);
    expect(limiter.tryConsume({ peerId: 'trusted-partner', tokens: 4 }).allowed).toBe(true);
  });

  it('raportează corect statusul și numărul de peer-i / skill-uri monitorizate', () => {
    const limiter = new GranularRateLimiter();
    limiter.tryConsume({ peerId: 'peer-1', skillId: 'skill-1' });
    limiter.tryConsume({ peerId: 'peer-2', skillId: 'skill-2' });

    const status = limiter.getStatus();
    expect(status.activePeersTracked).toBe(2);
    expect(status.activeSkillsTracked).toBe(2);
  });
});
