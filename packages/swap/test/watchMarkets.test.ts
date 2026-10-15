import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import { watchMarkets } from "../src/markets";
import { btcChf, btcUsd } from "./fixtures";
import { pointedSolver } from "./client/fixtures";
import { InMemoryAssetSwapRepository } from "../src/repository";

const REGISTRY_URL = "https://arkade-os.github.io/solver-registry/mutinynet.json";

const indexOf = (...markets: DiscoveredMarket[]) => ({
    version: 0,
    network: "mutinynet",
    generated_at: Math.floor(Date.now() / 1000),
    commit: "a".repeat(40),
    markets: markets.map(({ source: _source, sourceType: _sourceType, ...entry }) => entry),
});

const servingIndex = (initial: DiscoveredMarket[]) => {
    const served = { markets: initial };
    const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify(indexOf(...served.markets))),
    ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    return { served, fetchImpl };
};

describe("watchMarkets", () => {
    afterEach(() => vi.useRealTimers());

    it("emits the first read, then only a read that changes the set, and stops reading on stop()", async () => {
        vi.useFakeTimers();
        const { served, fetchImpl } = servingIndex([btcUsd]);
        const seen: string[][] = [];
        const stop = watchMarkets(
            {
                network: "mutinynet",
                registryUrl: REGISTRY_URL,
                fetchImpl,
                transportCards: null,
                intervalMs: 1000,
            },
            (markets) => seen.push(markets.map((m) => m.pair ?? "").sort()),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(seen).toEqual([["BTC/USD"]]);

        await vi.advanceTimersByTimeAsync(1000);
        expect(seen).toHaveLength(1);

        served.markets = [btcUsd, btcChf];
        await vi.advanceTimersByTimeAsync(1000);
        expect(seen).toEqual([["BTC/USD"], ["BTC/CHF", "BTC/USD"]]);

        served.markets = [btcChf, btcUsd];
        await vi.advanceTimersByTimeAsync(1000);
        expect(seen).toHaveLength(2);

        stop();
        const reads = fetchImpl.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetchImpl.mock.calls.length).toBe(reads);
    });

    it("refuses an interval that is zero or one a timer cannot hold, before reading anything", () => {
        const { fetchImpl } = servingIndex([btcUsd]);
        for (const intervalMs of [0, 2 ** 31]) {
            expect(() =>
                watchMarkets(
                    { network: "mutinynet", registryUrl: REGISTRY_URL, fetchImpl, intervalMs },
                    () => {},
                ),
            ).toThrow(/intervalMs/);
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("does not report a solver gone when only its card failed to arrive", async () => {
        vi.useFakeTimers();
        const pointed = pointedSolver();
        let relayUp = true;
        const seen: string[][] = [];
        const stop = watchMarkets(
            {
                network: "regtest",
                registryUrl: "https://registry.example/regtest.json",
                repository: new InMemoryAssetSwapRepository(),
                useCache: false,
                fetchImpl: (async () =>
                    new Response(JSON.stringify(pointed.index))) as unknown as typeof fetch,
                transportCards: {
                    fetch: async () => {
                        if (!relayUp) throw new Error("relay timed out");
                        return [pointed.card()];
                    },
                },
                intervalMs: 1000,
            },
            (markets) => seen.push(markets.map((m) => m.solver)),
        );
        await vi.advanceTimersByTimeAsync(0);
        relayUp = false;
        await vi.advanceTimersByTimeAsync(1000);
        relayUp = true;
        await vi.advanceTimersByTimeAsync(1000);
        stop();
        expect(seen).toEqual([["pointed"]]);
    });

    it("survives a listener that throws, and does not report it as a discovery failure", async () => {
        vi.useFakeTimers();
        const { served, fetchImpl } = servingIndex([btcUsd]);
        const logger = vi.fn();
        let calls = 0;
        const stop = watchMarkets(
            {
                network: "mutinynet",
                registryUrl: REGISTRY_URL,
                fetchImpl,
                transportCards: null,
                intervalMs: 1000,
                logger,
            },
            () => {
                calls++;
                throw new Error("listener bug");
            },
        );
        await vi.advanceTimersByTimeAsync(0);
        served.markets = [btcUsd, btcChf];
        await vi.advanceTimersByTimeAsync(1000);
        expect(calls).toBe(2);
        expect(logger).not.toHaveBeenCalledWith("solver discovery watch:", expect.anything());
        stop();
    });
});
