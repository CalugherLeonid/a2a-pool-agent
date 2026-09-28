export interface RateLimiterOptions {
  /** Maximum burst tokens in bucket (default: 10) */
  maxTokens?: number;
  /** Refill rate per second (default: 2) */
  refillRatePerSec?: number;
  /** Maximum allowed requests per 60-second sliding window */
  limitPerMinute?: number;
  /** Maximum allowed requests per 3600-second sliding window */
  limitPerHour?: number;
}

export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRatePerSec: number;
  private limitPerMinute?: number;
  private limitPerHour?: number;
  private lastRefill: number;
  private minuteTimestamps: number[] = [];
  private hourTimestamps: number[] = [];

  constructor(
    maxTokensOrOptions: number | RateLimiterOptions = 10,
    refillRatePerSec: number = 2,
  ) {
    if (typeof maxTokensOrOptions === 'object') {
      this.maxTokens = maxTokensOrOptions.maxTokens ?? 10;
      this.refillRatePerSec = maxTokensOrOptions.refillRatePerSec ?? 2;
      this.limitPerMinute = maxTokensOrOptions.limitPerMinute;
      this.limitPerHour = maxTokensOrOptions.limitPerHour;
    } else {
      this.maxTokens = maxTokensOrOptions;
      this.refillRatePerSec = refillRatePerSec;
    }
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsedSec * this.refillRatePerSec,
    );
    this.lastRefill = now;
  }

  private cleanWindows(now: number): void {
    const minuteWindow = now - 60_000;
    const hourWindow = now - 3_600_000;

    while (this.minuteTimestamps.length > 0 && this.minuteTimestamps[0]! < minuteWindow) {
      this.minuteTimestamps.shift();
    }
    while (this.hourTimestamps.length > 0 && this.hourTimestamps[0]! < hourWindow) {
      this.hourTimestamps.shift();
    }
  }

  public tryConsume(tokens = 1): boolean {
    const now = Date.now();
    this.refill();
    this.cleanWindows(now);

    // 1. Token bucket check
    if (this.tokens < tokens) {
      return false;
    }

    // 2. Sliding window check per minute
    if (
      this.limitPerMinute !== undefined &&
      this.minuteTimestamps.length + tokens > this.limitPerMinute
    ) {
      return false;
    }

    // 3. Sliding window check per hour
    if (
      this.limitPerHour !== undefined &&
      this.hourTimestamps.length + tokens > this.limitPerHour
    ) {
      return false;
    }

    // All checks passed — deduct tokens & track timestamps
    this.tokens -= tokens;
    for (let i = 0; i < tokens; i++) {
      this.minuteTimestamps.push(now);
      this.hourTimestamps.push(now);
    }
    return true;
  }

  public getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  public getMinuteUsage(): number {
    this.cleanWindows(Date.now());
    return this.minuteTimestamps.length;
  }

  public getHourUsage(): number {
    this.cleanWindows(Date.now());
    return this.hourTimestamps.length;
  }

  public getMinuteLimit(): number | undefined {
    return this.limitPerMinute;
  }

  public getHourLimit(): number | undefined {
    return this.limitPerHour;
  }

  public getStatus() {
    const now = Date.now();
    this.cleanWindows(now);
    const minuteCount = this.minuteTimestamps.length;
    const hourCount = this.hourTimestamps.length;
    const minuteRemaining =
      this.limitPerMinute !== undefined
        ? Math.max(0, this.limitPerMinute - minuteCount)
        : undefined;
    const hourRemaining =
      this.limitPerHour !== undefined
        ? Math.max(0, this.limitPerHour - hourCount)
        : undefined;

    return {
      availableTokens: this.getAvailableTokens(),
      maxTokens: this.maxTokens,
      slidingWindow: {
        minuteCount,
        minuteRemaining,
        minuteLimit: this.limitPerMinute,
        hourCount,
        hourRemaining,
        hourLimit: this.limitPerHour,
      },
    };
  }

  public reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
    this.minuteTimestamps = [];
    this.hourTimestamps = [];
  }
}
