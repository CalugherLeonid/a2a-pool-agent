/**
 * Granular Multi-Dimensional Rate Limiter.
 *
 * Implements isolated, tiered rate limiting:
 *   1. Global limits (overall agent ingress protection)
 *   2. Per-Peer limits (prevents noisy neighbors or runaway external agents from monopolizing resources)
 *   3. Per-Skill limits (protects computationally expensive tools and meta-tools)
 */

import { RateLimiter, type RateLimiterOptions } from './rate-limiter.js';

export interface GranularRateLimiterOptions {
  global?: RateLimiterOptions;
  peerDefaults?: RateLimiterOptions;
  skillDefaults?: RateLimiterOptions;
  peerOverrides?: Record<string, RateLimiterOptions>;
  skillOverrides?: Record<string, RateLimiterOptions>;
}

export interface GranularConsumeRequest {
  tokens?: number;
  peerId?: string;
  skillId?: string;
}

export interface GranularConsumeResult {
  allowed: boolean;
  reason?: string;
  details?: {
    globalAllowed: boolean;
    peerAllowed?: boolean;
    skillAllowed?: boolean;
  };
}

export class GranularRateLimiter {
  private readonly globalLimiter: RateLimiter;
  private readonly peerLimiters = new Map<string, RateLimiter>();
  private readonly skillLimiters = new Map<string, RateLimiter>();

  private readonly peerDefaults: RateLimiterOptions;
  private readonly skillDefaults: RateLimiterOptions;
  private readonly peerOverrides: Record<string, RateLimiterOptions>;
  private readonly skillOverrides: Record<string, RateLimiterOptions>;

  constructor(options?: GranularRateLimiterOptions) {
    this.globalLimiter = new RateLimiter(
      options?.global ?? {
        limitPerMinute: 120,
        maxTokens: 30,
        refillRatePerSec: 5,
      },
    );

    this.peerDefaults = options?.peerDefaults ?? {
      limitPerMinute: 30,
      maxTokens: 10,
      refillRatePerSec: 2,
    };

    this.skillDefaults = options?.skillDefaults ?? {
      limitPerMinute: 60,
      maxTokens: 15,
      refillRatePerSec: 3,
    };

    this.peerOverrides = options?.peerOverrides ?? {};
    this.skillOverrides = options?.skillOverrides ?? {};
  }

  public getPeerLimiter(peerId: string): RateLimiter {
    let limiter = this.peerLimiters.get(peerId);
    if (!limiter) {
      const config = this.peerOverrides[peerId] ?? this.peerDefaults;
      limiter = new RateLimiter(config);
      this.peerLimiters.set(peerId, limiter);
    }
    return limiter;
  }

  public getSkillLimiter(skillId: string): RateLimiter {
    let limiter = this.skillLimiters.get(skillId);
    if (!limiter) {
      const config = this.skillOverrides[skillId] ?? this.skillDefaults;
      limiter = new RateLimiter(config);
      this.skillLimiters.set(skillId, limiter);
    }
    return limiter;
  }

  public tryConsume(request: GranularConsumeRequest): GranularConsumeResult {
    const tokens = request.tokens ?? 1;

    // 1. Check Global limiter
    const globalAllowed = this.globalLimiter.tryConsume(tokens);
    if (!globalAllowed) {
      return {
        allowed: false,
        reason: 'global_rate_limit_exceeded',
        details: { globalAllowed: false },
      };
    }

    // 2. Check Per-Peer limiter if peerId provided
    let peerAllowed = true;
    if (request.peerId) {
      const peerLimiter = this.getPeerLimiter(request.peerId);
      peerAllowed = peerLimiter.tryConsume(tokens);
      if (!peerAllowed) {
        return {
          allowed: false,
          reason: `peer_rate_limit_exceeded:${request.peerId}`,
          details: { globalAllowed: true, peerAllowed: false },
        };
      }
    }

    // 3. Check Per-Skill limiter if skillId provided
    let skillAllowed = true;
    if (request.skillId) {
      const skillLimiter = this.getSkillLimiter(request.skillId);
      skillAllowed = skillLimiter.tryConsume(tokens);
      if (!skillAllowed) {
        return {
          allowed: false,
          reason: `skill_rate_limit_exceeded:${request.skillId}`,
          details: { globalAllowed: true, peerAllowed, skillAllowed: false },
        };
      }
    }

    return {
      allowed: true,
      details: { globalAllowed: true, peerAllowed, skillAllowed },
    };
  }

  public getStatus() {
    return {
      global: this.globalLimiter.getStatus(),
      activePeersTracked: this.peerLimiters.size,
      activeSkillsTracked: this.skillLimiters.size,
    };
  }

  public resetAll(): void {
    this.globalLimiter.reset();
    for (const limiter of this.peerLimiters.values()) {
      limiter.reset();
    }
    for (const limiter of this.skillLimiters.values()) {
      limiter.reset();
    }
  }
}
