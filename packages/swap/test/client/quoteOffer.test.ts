/**
 * The feed-priced backend on its own: the margin, the minted expiry, the spread
 * definition, and the one check this backend runs.
 *
 * `quoteFromFeed` is exercised directly here because two of its guarantees are
 * not reachable through a well-behaved client — the pair check fires only if the
 * plan that came back prices legs the resolver did not ask for, which is a
 * defence against discovery changing under us rather than against a caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuoteExpired, QuoteVerificationFailed } from "../../src/client/errors";
import { eligibleMarkets, marketRefOf } from "../../src/client/market";
import { FEED_TTL_MS, feedFetch, quoteFromFeed } from "../../src/client/quoteOffer";
import type { DiscoverySnapshot } from "../../src/client/discovery";
import { USD_ASSET_ID, spotCard } from "./fixtures";

const NOW = 1_700_000_000;

const snapshot: DiscoverySnapshot = {
    markets: [spotCard],
    ref: { fetchedAt: NOW * 1000, live: true, source: "injected" },
};

const ARKADE_BTC = { corridor: "arkade", assetId: "btc" } as const;
const ARKADE_USD = { corridor: "arkade", assetId: USD_ASSET_ID } as const;

const legs = { give: ARKADE_BTC, take: ARKADE_USD };
const endpoints = {
    give: { corridor: "arkade" as const, asset: "arkade:regtest/slip44:0" as const },
    take: {
        corridor: "arkade" as const,
        asset: `arkade:regtest/asset:${USD_ASSET_ID}` as const,
    },
};

const serving = (price = 100_000) => {
    const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ price })),
    ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    return { fetchImpl, feed: feedFetch(fetchImpl) };
};

const quoteWith = (
    over: Parameters<typeof quoteFromFeed>[0] extends infer T ? Partial<T> : never,
) => {
    const [candidate] = eligibleMarkets(snapshot, legs);
    const { fetchImpl, feed } = serving();
    return {
        fetchImpl,
        run: () =>
            quoteFromFeed({
                quoteId: "q1",
                candidate,
                market: marketRefOf(candidate, snapshot.ref),
                legs,
                endpoints,
                amount: { value: 10_000n, on: "give", source: "caller" },
                feed,
                now: NOW,
                ...over,
            }),
    };
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("the margin", () => {
    it("concedes the card's fee and no cushion", async () => {
        const { quote } = await quoteWith({}).run();
        // 10_000 sats at 0.1 cents/sat is 1000 cents; 30bps is the whole
        // concession, where `quoteOffer`'s own default would have taken 80.
        expect(quote.take.amount).toBe(997n);
        expect(quote.fee.amount).toBe(3n);
        expect(quote.fee.asset).toBe(endpoints.take.asset);
    });

    it("denominates the spread on the leg where it is exact", async () => {
        const { quote } = await quoteWith({}).run();
        // The two legs carry different assets, so a give-denominated fee would
        // be this number divided by the price — a rounding nobody asked for.
        expect(quote.fee.asset).toBe(quote.take.asset);
        expect(quote.fee.asset).not.toBe(quote.give.asset);
    });
});

describe("the minted expiry", () => {
    it("expires with the feed value it was priced from", async () => {
        const { quote } = await quoteWith({}).run();
        expect(quote.expiresAt).toBe(NOW + FEED_TTL_MS / 1000);
    });

    it("ages with the cached feed value rather than restarting on a cache hit", async () => {
        const [candidate] = eligibleMarkets(snapshot, legs);
        const { fetchImpl, feed } = serving();
        const input = {
            quoteId: "q1",
            candidate,
            market: marketRefOf(candidate, snapshot.ref),
            legs,
            endpoints,
            amount: { value: 10_000n, on: "give" as const, source: "caller" as const },
            feed,
        };
        const first = await quoteFromFeed({ ...input, now: NOW });
        vi.setSystemTime((NOW + 10) * 1000);
        const second = await quoteFromFeed({ ...input, now: NOW + 10 });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        // The second quote is ten seconds younger and expires at the same
        // moment, because it is the same price.
        expect(second.quote.expiresAt).toBe(first.quote.expiresAt);
    });

    it("refuses a quote the policy floor outlives", async () => {
        await expect(quoteWith({ policy: { quoteTtlFloorSeconds: 60 } }).run()).rejects.toThrow(
            QuoteExpired,
        );
    });
});

describe("the one check this backend runs", () => {
    it("refuses a plan that prices legs nobody asked for", async () => {
        await expect(
            quoteWith({
                legs: { give: ARKADE_BTC, take: { corridor: "arkade", assetId: "ff".repeat(34) } },
            }).run(),
        ).rejects.toThrow(QuoteVerificationFailed);
    });

    it("needs an amount, since no invoice can pin one here", async () => {
        await expect(quoteWith({ amount: undefined }).run()).rejects.toThrow(/needs an amount/);
    });
});
