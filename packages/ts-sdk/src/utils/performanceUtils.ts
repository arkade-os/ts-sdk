/**
 * Simple concurrency limiter to prevent resource exhaustion during
 * high-volume VTXO verification.
 */
export class ConcurrencyLimiter {
    private activeCount = 0;
    private queue: (() => void)[] = [];

    constructor(private maxConcurrency: number) {
        if (maxConcurrency <= 0) {
            throw new Error("ConcurrencyLimiter maxConcurrency must be positive");
        }
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.activeCount >= this.maxConcurrency) {
            await new Promise<void>((resolve) => this.queue.push(resolve));
        } else {
            this.activeCount++;
        }
        try {
            return await fn();
        } finally {
            if (this.queue.length > 0) {
                // Next task inherits our slot atomically
                const next = this.queue.shift();
                if (next) next();
            } else {
                this.activeCount--;
            }
        }
    }
}
