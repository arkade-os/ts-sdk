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
