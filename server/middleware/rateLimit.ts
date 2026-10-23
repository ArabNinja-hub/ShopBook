import { RateLimitError } from '../errors';

interface WindowBucket {
  timestamps: number[];
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, WindowBucket>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(options: {
    maxRequests: number;
    windowMs: number;
    maxKeys?: number;
  }) {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  consume(key: string, nowMs: number = Date.now()): void {
    const cutoff = nowMs - this.windowMs;
    let bucket = this.buckets.get(key);

    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        this.prune(cutoff);
      }
      bucket = { timestamps: [] };
      this.buckets.set(key, bucket);
    }

    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

    if (bucket.timestamps.length >= this.maxRequests) {
      const oldestInWindow = bucket.timestamps[0] ?? nowMs;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldestInWindow + this.windowMs - nowMs) / 1000)
      );
      throw new RateLimitError(retryAfterSeconds);
    }

    bucket.timestamps.push(nowMs);
  }

  private prune(cutoff: number): void {
    for (const [k, b] of this.buckets.entries()) {
      const active = b.timestamps.filter((t) => t > cutoff);
      if (active.length === 0) {
        this.buckets.delete(k);
      } else {
        b.timestamps = active;
      }
    }
  }
}
