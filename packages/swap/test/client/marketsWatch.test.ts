/** The opt-in discovery watch: what arms it, what it reports, and what stops it. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import { createSwapClient, type SwapClientConfig } from "../../src/client/client";
import { ClientDisposed, DiscoverySnapshotUnavailable } from "../../src/client/errors";
import type { Market } from "../../src/client/market";
import { hdWallet, indexOf, lightningCard, rivalLightningCard, spotCard } from "./fixtures";

const REGISTRY = "https://registry.example/regtest.json";

/** A registry the test re-lists between refreshes. */
const registry = (listing: DiscoveredMarket[]) => {
    let markets = listing;
    let reachable = true;
    const fetchImpl = vi.fn(async () => {
        if (!reachable) throw new Error("registry unreachable");
        return new Response(JSON.stringify(indexOf(markets)));
    });
    return {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        fetches: () => fetchImpl.mock.calls.length,
        list: (next: DiscoveredMarket[]) => {
            markets = next;
        },
        down: () => {
            reachable = false;
        },
    };
};

/** Every interval the client arms, run by hand: `tick()` settles when that poll has. */
const intervals = () => {
    const armed: { poll: () => Promise<void>; ms: number; unref: () => void }[] = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
        poll: () => Promise<void>,
        ms: number,
    ) => {
        const timer = { poll, ms, unref: vi.fn() };
        armed.push(timer);
        return timer;
    }) as never);
    const cleared = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    return { armed, cleared, tick: () => armed[armed.length - 1].poll() };
};

const clientOf = async (
    reg: ReturnType<typeof registry>,
    discovery: SwapClientConfig["discovery"] = {},
) =>
    createSwapClient({
        wallet: await hdWallet(),
        discovery: {
            registryUrl: REGISTRY,
            fetchImpl: reg.fetchImpl,
            transportCards: null,
            ...discovery,
        },
    });

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("onMarketsChanged", () => {
    it("reports a solver added, a card changed and a solver gone, and nothing else", async () => {
        const timers = intervals();
        const reg = registry([lightningCard]);
        const client = await clientOf(reg, { watch: true, watchIntervalMs: 1_000 });
        const seen: Market[][] = [];
        client.onMarketsChanged((markets) => seen.push(markets));
        expect(timers.armed.map((t) => t.ms)).toEqual([1_000]);
        await client.markets();

        await timers.tick();
        expect(seen).toEqual([]);

        const repriced = { ...spotCard, fee_bps: 45 };
        for (const listing of [[lightningCard, spotCard], [lightningCard, repriced], [repriced]]) {
            reg.list(listing);
            await timers.tick();
            expect(seen[seen.length - 1]).toEqual(await client.markets());
        }
        expect(seen.map((markets) => markets.length)).toEqual([2, 2, 1]);

        await timers.tick();
        expect(seen).toHaveLength(3);
        expect(reg.fetches()).toBe(6);
        await client[Symbol.asyncDispose]();
    });

    it("reads the market set as a set: two tied solvers swapping places is no change", async () => {
        const twin = { ...rivalLightningCard, fee_bps: lightningCard.fee_bps };
        const timers = intervals();
        const reg = registry([lightningCard, twin]);
        const client = await clientOf(reg, { watch: true });
        const seen = vi.fn();
        client.onMarketsChanged(seen);
        await client.markets();

        reg.list([twin, lightningCard]);
        await timers.tick();
        expect(seen).not.toHaveBeenCalled();
        await client[Symbol.asyncDispose]();
    });

    it("hears a refresh on use too, past the TTL, with no watch armed", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const timers = intervals();
        const reg = registry([lightningCard]);
        const client = await clientOf(reg);
        const seen: Market[][] = [];
        client.onMarketsChanged((markets) => seen.push(markets));
        await client.markets();

        reg.list([lightningCard, spotCard]);
        vi.advanceTimersByTime(10 * 60_000);
        await client.markets();
        reg.list([spotCard]);
        vi.advanceTimersByTime(10 * 60_000);
        await client.markets();

        expect(seen.map((markets) => markets.length)).toEqual([2, 1]);
        expect(timers.armed).toEqual([]);
        await client[Symbol.asyncDispose]();
    });

    it("polls on one unref'd five-minute timer, only while someone listens", async () => {
        const timers = intervals();
        const client = await clientOf(registry([lightningCard]), { watch: true });
        expect(timers.armed).toEqual([]);

        const offA = client.onMarketsChanged(() => {});
        const offB = client.onMarketsChanged(() => {});
        expect(timers.armed).toHaveLength(1);
        expect(timers.armed[0].ms).toBe(300_000);
        expect(timers.armed[0].unref).toHaveBeenCalled();

        offA();
        expect(timers.cleared).not.toHaveBeenCalled();
        offB();
        expect(timers.cleared).toHaveBeenCalledWith(timers.armed[0]);

        client.onMarketsChanged(() => {});
        expect(timers.armed).toHaveLength(2);
        await client[Symbol.asyncDispose]();
        expect(timers.cleared).toHaveBeenLastCalledWith(timers.armed[1]);
    });

    it("refuses a new listener once disposed, leaving an issued unsubscribe a no-op", async () => {
        intervals();
        const client = await clientOf(registry([lightningCard]), { watch: true });
        const off = client.onMarketsChanged(() => {});
        await client[Symbol.asyncDispose]();

        expect(() => off()).not.toThrow();
        expect(() => client.onMarketsChanged(() => {})).toThrow(ClientDisposed);
    });

    it("keeps polling past a throwing listener and an unreachable registry", async () => {
        const timers = intervals();
        const logger = vi.fn();
        const reg = registry([lightningCard]);
        const client = await clientOf(reg, { watch: true, logger });
        const seen: Market[][] = [];
        client.onMarketsChanged(() => {
            throw new Error("a consumer's bug");
        });
        client.onMarketsChanged((markets) => seen.push(markets));
        await client.markets();

        reg.list([]);
        await expect(timers.tick()).resolves.toBeUndefined();
        expect(seen).toEqual([[]]);

        reg.down();
        await expect(timers.tick()).resolves.toBeUndefined();
        expect(logger).toHaveBeenCalledWith(
            "solver discovery watch:",
            expect.any(DiscoverySnapshotUnavailable),
        );
        await client[Symbol.asyncDispose]();
    });
});
