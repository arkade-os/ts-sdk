/**
 * Origin-scoped politeness gate for outbound provider requests.
 *
 * Per-request retry alone cannot survive a rate limiter: under a burst every
 * in-flight request gets the same `429` and the same `Retry-After`, sleeps
 * independently, and wakes in unison to re-trip it — while requests queued
 * behind them learn nothing from the `429` at all. So the backoff state is
 * shared, keyed by **origin** (`/v1/info` and `/v1/indexer/*` are one host
 * behind one limiter). Callers use one of two verbs:
 *
 * - **Wait + report** ({@link OriginRateGate.runHttp}) — indexer and operator
 *   reads, where delaying a send is safe. Waiting is separate from retrying:
 *   an indexer POST waits and reports but is not replayed (see `indexerFetch`).
 * - **Report-only** ({@link OriginRateGate.reportRateLimited}) — intent and
 *   settlement POSTs, which feed the shared signal but never wait or retry:
 *   batch sessions have deadlines, and these POSTs are not idempotent at the
 *   application level, so a certain missed round beats a possible `429`.
 */

/** Per-origin in-flight cap on the wait+report path (the browser per-host cap). */
const DEFAULT_MAX_CONCURRENT = 6;

/** Cooldown applied to a `429` that carries no usable `Retry-After`. */
const DEFAULT_COOLDOWN_MS = 5_000;

/** Ceiling on a single cooldown, so a bogus `Retry-After` can't wedge the wallet. */
const MAX_COOLDOWN_MS = 60_000;

/** Upper bound of the random delay decorrelating waiters released together. */
const DEFAULT_JITTER_MS = 500;

export interface RateGateOptions {
    maxConcurrent?: number;
    defaultCooldownMs?: number;
    maxCooldownMs?: number;
    jitterMs?: number;
}

interface OriginState {
    /** Epoch ms before which no gated request to this origin may be sent. */
    blockedUntil: number;
    /** In-flight gated requests. */
    active: number;
    /** FIFO of waiters parked on the concurrency cap. */
    queue: (() => void)[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse a `Retry-After` header into milliseconds, in either spec encoding
 * (delta-seconds or HTTP-date). `undefined` when absent or unparseable.
 */
export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
    if (header === null || header === undefined) return undefined;
    const trimmed = header.trim();
    // Checked before Number(), which maps "" to 0.
    if (trimmed === "") return undefined;

    const seconds = Number(trimmed);
    // A negative delta is malformed — delta-seconds is non-negative — so there
    // is no valid reading of it. Fall back to the caller's default instead of
    // clamping to 0, which would mean "no cooldown at all".
    if (Number.isFinite(seconds)) return seconds < 0 ? undefined : seconds * 1000;

    // Unlike a negative delta, a past HTTP-date is well-formed and does mean
    // "retry now", so it clamps rather than falling back.
    const at = Date.parse(trimmed);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());

    return undefined;
}

/** Derive the origin key for a `fetch` input, tolerating the three input shapes. */
export function requestOrigin(input: RequestInfo | URL): string {
    let url: string;
    if (typeof input === "string") {
        url = input;
    } else if (input instanceof URL) {
        url = input.href;
    } else {
        url = input.url;
    }
    try {
        return new URL(url).origin;
    } catch {
        // Unparseable (e.g. relative): key on the raw string. Grouping is then
        // wrong, but only ever over- or under-shares a cooldown.
        return url;
    }
}

/** Shared cooldown + concurrency state, keyed by origin. */
export class OriginRateGate {
    private readonly states = new Map<string, OriginState>();
    private readonly maxConcurrent: number;
    private readonly defaultCooldownMs: number;
    private readonly maxCooldownMs: number;
    private readonly jitterMs: number;

    constructor(options?: RateGateOptions) {
        this.maxConcurrent = options?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
        this.defaultCooldownMs = options?.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;
        this.maxCooldownMs = options?.maxCooldownMs ?? MAX_COOLDOWN_MS;
        this.jitterMs = options?.jitterMs ?? DEFAULT_JITTER_MS;
    }

    /**
     * Run `fn` under the origin's concurrency cap and behind any active
     * cooldown. Put only the request in `fn`: the slot is released as soon as
     * it settles, so body parsing doesn't hold one.
     */
    async run<T>(input: RequestInfo | URL, fn: () => Promise<T>): Promise<T> {
        const state = this.stateFor(requestOrigin(input));
        await this.acquire(state);
        try {
            // Re-checked after each sleep, so a `429` seen by another request
            // while this one waits extends the wait instead of slipping through.
            for (;;) {
                const remaining = state.blockedUntil - Date.now();
                if (remaining <= 0) break;
                await sleep(remaining + Math.random() * this.jitterMs);
            }
            return await fn();
        } finally {
            this.release(state);
        }
    }

    /**
     * {@link run} for a request whose response the gate should inspect: a `429`
     * is recorded *before* the slot is released. Reporting after `run()` resolves
     * is too late — `release()` hands the slot to the next queued waiter, which
     * resumes, sees no cooldown, and sends into the limiter that just refused us.
     *
     * Prefer this over `run` for anything returning a `Response`.
     */
    runHttp(input: RequestInfo | URL, fn: () => Promise<Response>): Promise<Response> {
        return this.run(input, async () => {
            const response = await fn();
            if (response.status === 429) {
                this.reportRateLimited(input, response.headers?.get("retry-after"));
            }
            return response;
        });
    }

    /**
     * Record an observed `429`, pausing every gated request to that origin.
     * Monotonic: a shorter cooldown never shortens one already in effect.
     */
    reportRateLimited(input: RequestInfo | URL, retryAfterHeader?: string | null): void {
        const cooldown = Math.min(
            parseRetryAfterMs(retryAfterHeader) ?? this.defaultCooldownMs,
            this.maxCooldownMs,
        );
        const state = this.stateFor(requestOrigin(input));
        state.blockedUntil = Math.max(state.blockedUntil, Date.now() + cooldown);
    }

    /** Milliseconds left on `input` origin's cooldown; `0` when not cooling down. */
    cooldownRemainingMs(input: RequestInfo | URL): number {
        const state = this.states.get(requestOrigin(input));
        if (!state) return 0;
        return Math.max(0, state.blockedUntil - Date.now());
    }

    /**
     * Drop all per-origin state, so test suites don't inherit each other's
     * cooldowns. Waiters queued on the discarded state still drain normally.
     */
    reset(): void {
        this.states.clear();
    }

    private stateFor(origin: string): OriginState {
        let state = this.states.get(origin);
        if (!state) {
            state = { blockedUntil: 0, active: 0, queue: [] };
            this.states.set(origin, state);
        }
        return state;
    }

    private acquire(state: OriginState): Promise<void> {
        if (state.active < this.maxConcurrent) {
            state.active += 1;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            state.queue.push(() => {
                state.active += 1;
                resolve();
            });
        });
    }

    private release(state: OriginState): void {
        state.active -= 1;
        const next = state.queue.shift();
        if (next) next();
    }
}

/**
 * Process-wide gate shared by every provider fetch path. Origin keying keeps
 * embedders on several operators from cross-throttling each other.
 */
export const rateGate = new OriginRateGate();
