import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    computeReconnectDelay,
    ContractWatcher,
    DEFAULT_CONTRACT_WATCHER_CONFIG,
    type ContractWatcherConfig,
} from "../src/contracts/contractWatcher";
import { InMemoryWalletRepository } from "../src";
import type { Contract } from "../src/contracts/types";
import type { IndexerProvider } from "../src/providers/indexer";

describe("computeReconnectDelay", () => {
    it("grows exponentially from the base delay", () => {
        expect(computeReconnectDelay(1, 1000, 5000)).toBe(1000); // 1000 * 2^0
        expect(computeReconnectDelay(2, 1000, 5000)).toBe(2000); // 1000 * 2^1
        expect(computeReconnectDelay(3, 1000, 5000)).toBe(4000); // 1000 * 2^2
    });

    it("caps at maxMs so recovery after a server restart stays prompt", () => {
        expect(computeReconnectDelay(4, 1000, 5000)).toBe(5000); // 8000 -> capped
        expect(computeReconnectDelay(20, 1000, 5000)).toBe(5000); // far past the cap
    });
});

describe("ContractWatcher reconnect defaults", () => {
    it("retries promptly at first and backs far off under a persistent refusal", () => {
        // The failsafe poll bounds recovery, so the cap can outlast a rate limiter.
        expect(DEFAULT_CONTRACT_WATCHER_CONFIG.reconnectDelayMs).toBeLessThanOrEqual(1_000);
        expect(DEFAULT_CONTRACT_WATCHER_CONFIG.maxReconnectDelayMs).toBeGreaterThanOrEqual(60_000);
        expect(DEFAULT_CONTRACT_WATCHER_CONFIG.failsafePollIntervalMs).toBeLessThanOrEqual(20_000);
    });
});

const contract = (script: string): Contract => ({
    type: "default",
    params: {},
    script,
    address: `ark1q${script}`,
    createdAt: 0,
    state: "active",
    watch: "watched",
});

const refused = (status: number, retryAfterMs?: number): Error =>
    Object.assign(new Error(`EventSource error (${status})`), {
        name: "EventSourceError",
        status,
        retryAfterMs,
    });

describe("ContractWatcher stream reconnect", () => {
    const watchers: ContractWatcher[] = [];

    beforeEach(() => vi.useFakeTimers());
    afterEach(async () => {
        for (const watcher of watchers.splice(0)) await watcher.stopWatching();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    async function setup(overrides: Partial<ContractWatcherConfig>, { opens = true } = {}) {
        let release: ((failure?: unknown) => void) | undefined;
        const listen = vi.fn(async function* (_id: string, signal: AbortSignal) {
            if (opens) yield {};
            const failure = await new Promise<unknown>((resolve) => {
                release = resolve;
                if (signal.aborted) resolve(undefined);
                else signal.addEventListener("abort", () => resolve(undefined), { once: true });
            });
            if (failure) throw failure;
        });
        const watcher = new ContractWatcher({
            indexerProvider: {
                subscribeForScripts: vi.fn(async () => "sub-1"),
                unsubscribeForScripts: vi.fn(async () => {}),
                getSubscription: listen,
                getVtxos: vi.fn(async () => ({ vtxos: [] })),
            } as unknown as IndexerProvider,
            walletRepository: new InMemoryWalletRepository(),
            failsafePollIntervalMs: 600_000,
            ...overrides,
        });
        watchers.push(watcher);
        await watcher.addContract(contract("aa"));
        await watcher.startWatching(() => {});
        await vi.advanceTimersByTimeAsync(0);
        expect(listen).toHaveBeenCalledTimes(1);

        return {
            listen,
            drop: async (failure?: unknown) => {
                release?.(failure);
                release = undefined;
                await vi.advanceTimersByTimeAsync(0);
            },
        };
    }

    it("grows the delay exponentially under jitter and caps it", async () => {
        // Math.random() of 0 is the low end of equal jitter: half the exponential delay.
        vi.spyOn(Math, "random").mockReturnValue(0);
        const { listen, drop } = await setup({
            reconnectDelayMs: 1_000,
            maxReconnectDelayMs: 8_000,
        });

        for (const [calls, delay] of [
            [2, 500],
            [3, 1_000],
            [4, 2_000],
            [5, 4_000],
            [6, 4_000],
        ]) {
            await drop();
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(listen).toHaveBeenCalledTimes(calls - 1);
            await vi.advanceTimersByTimeAsync(1);
            expect(listen).toHaveBeenCalledTimes(calls);
        }
    });

    it("never delays past the exponential value, whatever the jitter", async () => {
        vi.spyOn(Math, "random").mockReturnValue(1);
        const { listen, drop } = await setup({
            reconnectDelayMs: 1_000,
            maxReconnectDelayMs: 8_000,
        });

        await drop();
        await vi.advanceTimersByTimeAsync(999);
        expect(listen).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(listen).toHaveBeenCalledTimes(2);
    });

    it("resets the ladder only after a connection stays up past the cap", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const { listen, drop } = await setup({
            reconnectDelayMs: 1_000,
            maxReconnectDelayMs: 4_000,
        });

        await drop();
        await vi.advanceTimersByTimeAsync(500);
        await drop();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(listen).toHaveBeenCalledTimes(3);

        await vi.advanceTimersByTimeAsync(4_000);
        await drop();
        await vi.advanceTimersByTimeAsync(499);
        expect(listen).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(listen).toHaveBeenCalledTimes(4);
    });

    it("treats half a minute up as healthy under the long default cap", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const { listen, drop } = await setup({ reconnectDelayMs: 1_000 });

        for (const delay of [500, 1_000, 2_000]) {
            await drop();
            await vi.advanceTimersByTimeAsync(delay);
        }
        expect(listen).toHaveBeenCalledTimes(4);

        await vi.advanceTimersByTimeAsync(29_999);
        await drop();
        await vi.advanceTimersByTimeAsync(3_999);
        expect(listen).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(1);
        expect(listen).toHaveBeenCalledTimes(5);

        await vi.advanceTimersByTimeAsync(30_000);
        await drop();
        await vi.advanceTimersByTimeAsync(500);
        expect(listen).toHaveBeenCalledTimes(6);
    });

    it("waits out the Retry-After of a refused stream", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const { listen, drop } = await setup({
            reconnectDelayMs: 1_000,
            maxReconnectDelayMs: 4_000,
        });

        await drop(refused(429, 10_000));
        await vi.advanceTimersByTimeAsync(9_999);
        expect(listen).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(listen).toHaveBeenCalledTimes(2);
    });

    it("stops after the configured attempt limit", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const { listen, drop } = await setup({
            reconnectDelayMs: 1_000,
            maxReconnectDelayMs: 4_000,
            maxReconnectAttempts: 2,
        });

        // Each reconnect is dropped before it counts as stable, so the attempts accumulate.
        await drop();
        await vi.advanceTimersByTimeAsync(500);
        await drop();
        await vi.advanceTimersByTimeAsync(1_000);
        await drop();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(listen).toHaveBeenCalledTimes(3); // the initial connect and two retries
    });

    it("does not count a slow open that never delivers as uptime", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const { listen, drop } = await setup(
            { reconnectDelayMs: 1_000, maxReconnectAttempts: 2 },
            { opens: false },
        );

        for (const delay of [500, 1_000]) {
            await vi.advanceTimersByTimeAsync(31_000);
            await drop();
            await vi.advanceTimersByTimeAsync(delay);
        }
        await vi.advanceTimersByTimeAsync(31_000);
        await drop();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(listen).toHaveBeenCalledTimes(3);
    });
});
