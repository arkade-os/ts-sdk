/**
 * Simple concurrency limiter to prevent resource exhaustion during
 * high-volume VTXO verification.
 */
export class ConcurrencyLimiter {
  private activeCount = 0;
  private queue: (() => void)[] = [];

  constructor(private maxConcurrency: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }

    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next) next();
      }
    }
  }
}

/**
 * A simple TTL-based cache for VTXO verification results.
 * Helps avoid redundant computations for the same DAG.
 */
export class VerificationCache {
  private cache = new Map<string, { result: any; expiry: number }>();

  constructor(private ttlMs: number = 300000) {} // Default 5 mins

  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    return entry.result;
  }

  set(key: string, result: any): void {
    this.cache.set(key, {
      result,
      expiry: Date.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.cache.clear();
  }
}
