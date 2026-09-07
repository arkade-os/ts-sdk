import { beforeEach, describe, expect, it, vi } from "vitest";
import { planOffer, quoteOffer, type DiscoveredMarket } from "@arkade-os/solver-discovery";
import {
    discoverMarkets,
    findMarket,
    makeCachedFeedFetch,
    QUOTE_OPTIONS,
    validatePlan,
} from "../src/markets";
import { InMemoryAssetSwapRepository } from "../src/repository";
import { btcChf, btcUsd, CHF_ID, USD_ID, XAU_ID, xauUsd } from "./fixtures";

const markets = [btcUsd, btcChf];

const jsonFetch = (bodies: (unknown | Error)[]) => {
    let i = 0;
    return vi.fn(async () => {
        const body = bodies[Math.min(i++, bodies.length - 1)];
        if (body instanceof Error) throw body;
        return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
};

describe("findMarket", () => {
    it("maps btc->asset to giving the base side", () => {
        expect(findMarket(markets, "btc", USD_ID)).toEqual({ market: btcUsd, give: "base" });
        expect(findMarket(markets, "btc", CHF_ID)).toEqual({ market: btcChf, give: "base" });
    });

    it("maps asset->btc to giving the quote side", () => {
        expect(findMarket(markets, USD_ID, "btc")).toEqual({ market: btcUsd, give: "quote" });
    });

    it("maps asset<->asset pairs in both orientations (#857)", () => {
        const withCrossMarkets = [...markets, xauUsd];
        expect(findMarket(withCrossMarkets, XAU_ID, USD_ID)).toEqual({
            market: xauUsd,
            give: "base",
        });
        expect(findMarket(withCrossMarkets, USD_ID, XAU_ID)).toEqual({
            market: xauUsd,
            give: "quote",
        });
    });

    it("has no market for unserved asset<->asset pairs, none at all for same-asset", () => {
        expect(findMarket(markets, USD_ID, CHF_ID)?.market).toBeNull();
        expect(findMarket(markets, "btc", "btc")).toBeUndefined();
    });

    it("returns a null market for unknown assets", () => {
        expect(findMarket(markets, "btc", "ff".repeat(34))?.market).toBeNull();
    });
});

describe("quoteOffer with the package quote options", () => {
    it("quotes btc->usd through the nested CoinGecko schema (fee + safety conceded)", async () => {
        const fetchImpl = jsonFetch([{ bitcoin: { usd: 100000 } }]);
        const plan = await quoteOffer(btcUsd, {
            give: "base",
            giveAmount: BigInt(10_000),
            fetchImpl,
            ...QUOTE_OPTIONS,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(plan.deposit.atomic).toBe(BigInt(10_000));
        // 10_000 sats * 0.1 cents/sat * (10000 - 30)bps = 997 cents
        expect(plan.receive.atomic).toBe(BigInt(997));
        expect(plan.receive.display).toBe("9.97");
        expect(plan.limits.withinLimits).toBe(true);
    });

    it("quotes usd->btc in the same market (give quote side)", async () => {
        const fetchImpl = jsonFetch([{ bitcoin: { usd: 100000 } }]);
        const plan = await quoteOffer(btcUsd, {
            give: "quote",
            giveAmount: BigInt(1_000),
            fetchImpl,
            ...QUOTE_OPTIONS,
        });
        expect(plan.deposit.atomic).toBe(BigInt(1_000));
        // $10 / 0.1 cents-per-sat, minus the 30bps fee: 9970 sats
        expect(plan.receive.atomic).toBe(BigInt(9_970));
    });

    it("quotes btc->chf through the Binance /price schema", async () => {
        const fetchImpl = jsonFetch([{ symbol: "BTCCHF", price: "600000.00" }]);
        const plan = await quoteOffer(btcChf, {
            give: "base",
            giveAmount: BigInt(10_000),
            fetchImpl,
            ...QUOTE_OPTIONS,
        });
        // 10_000 sats * 600_000 chf-atomic/sat * 9970bps = 59.82 CHF
        expect(plan.receive.atomic).toBe(BigInt(5_982_000_000));
        expect(plan.receive.display).toBe("59.82");
    });
});

describe("makeCachedFeedFetch", () => {
    it("keeps repeated quotes within the TTL to a single feed call", async () => {
        // the invariant behind the wallet's flat-feedCalls screen test: a burst of
        // debounced quotes against the same feed URL must hit the network once, or
        // rate-limited public feeds turn typing into "Quote unavailable"
        const underlying = vi.fn(
            async () => new Response(JSON.stringify({ bitcoin: { usd: 100000 } })),
        );
        const fetchImpl = makeCachedFeedFetch(30_000, underlying as unknown as typeof fetch);
        const first = await quoteOffer(btcUsd, {
            give: "base",
            giveAmount: BigInt(10_000),
            fetchImpl,
            ...QUOTE_OPTIONS,
        });
        const second = await quoteOffer(btcUsd, {
            give: "base",
            giveAmount: BigInt(20_000),
            fetchImpl,
            ...QUOTE_OPTIONS,
        });
        expect(underlying).toHaveBeenCalledTimes(1);
        expect(first.receive.atomic).toBe(BigInt(997));
        expect(second.receive.atomic).toBe(BigInt(1_994));
    });

    it("collapses concurrent quotes started inside one round trip to a single call", async () => {
        // the sequential test above only proves the cache dedups *after* a
        // response lands; a debounced UI fires its burst before that, so
        // without in-flight dedup every keystroke still costs an upstream call
        let release: () => void = () => {};
        const arrived = new Promise<void>((resolve) => {
            release = resolve;
        });
        const underlying = vi.fn(async () => {
            await arrived;
            return new Response(JSON.stringify({ bitcoin: { usd: 100000 } }));
        });
        const fetchImpl = makeCachedFeedFetch(30_000, underlying as unknown as typeof fetch);
        const quote = (giveAmount: bigint) =>
            quoteOffer(btcUsd, { give: "base", giveAmount, fetchImpl, ...QUOTE_OPTIONS });

        const all = Promise.all([quote(BigInt(10_000)), quote(BigInt(20_000))]);
        release();
        const [first, second] = await all;

        expect(underlying).toHaveBeenCalledTimes(1);
        expect(first.receive.atomic).toBe(BigInt(997));
        expect(second.receive.atomic).toBe(BigInt(1_994));
    });

    it("refetches once the TTL has elapsed", async () => {
        const underlying = vi.fn(
            async () => new Response(JSON.stringify({ bitcoin: { usd: 100000 } })),
        );
        // a 0ms TTL expires before the second call, so the window must reopen
        const fetchImpl = makeCachedFeedFetch(0, underlying as unknown as typeof fetch);
        const quote = () =>
            quoteOffer(btcUsd, {
                give: "base",
                giveAmount: BigInt(10_000),
                fetchImpl,
                ...QUOTE_OPTIONS,
            });
        await quote();
        await quote();
        expect(underlying).toHaveBeenCalledTimes(2);
    });

    it("never caches a rate-limited response", async () => {
        // the rate-limit case is the whole reason the cache exists — caching a
        // 429 body would pin the failure for the rest of the TTL window
        const underlying = vi
            .fn()
            .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
            .mockResolvedValue(new Response(JSON.stringify({ bitcoin: { usd: 100000 } })));
        const fetchImpl = makeCachedFeedFetch(30_000, underlying as unknown as typeof fetch);
        const quote = () =>
            quoteOffer(btcUsd, {
                give: "base",
                giveAmount: BigInt(10_000),
                fetchImpl,
                ...QUOTE_OPTIONS,
            });

        await expect(quote()).rejects.toThrow();
        // the retry reaches the network and succeeds rather than replaying the 429
        expect((await quote()).receive.atomic).toBe(BigInt(997));
        expect(underlying).toHaveBeenCalledTimes(2);
    });
});

describe("discoverMarkets caching", () => {
    const REGISTRY_URL = "https://arkade-os.github.io/solver-registry/mutinynet.json";
    // a valid registry index entry: btcUsd without the fields discover() adds
    const indexMarket: Record<string, unknown> = { ...btcUsd };
    delete indexMarket.source;
    delete indexMarket.sourceType;
    const registryIndex = () => ({
        version: 0,
        network: "mutinynet",
        generated_at: Math.floor(Date.now() / 1000),
        commit: "a".repeat(40),
        markets: [indexMarket],
    });

    let repository: InMemoryAssetSwapRepository;
    const discoverWith = (fetchImpl: typeof fetch) =>
        discoverMarkets({ network: "mutinynet", registryUrl: REGISTRY_URL, repository, fetchImpl });
    const cache = () => repository.getCachedMarkets("mutinynet", REGISTRY_URL);
    const seedCache = (fetchedAt: number, markets: DiscoveredMarket[] = [btcUsd]) =>
        repository.saveCachedMarkets("mutinynet", REGISTRY_URL, { markets, fetchedAt });

    beforeEach(() => {
        repository = new InMemoryAssetSwapRepository();
    });

    it("fetches on a cold start and caches the result", async () => {
        const fetchImpl = jsonFetch([registryIndex()]);
        const markets = await discoverWith(fetchImpl);
        expect(markets).toHaveLength(1);
        expect(markets[0].pair).toBe("BTC/USD");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect((await cache())?.markets).toHaveLength(1);
    });

    it("serves a fresh cache without fetching", async () => {
        await seedCache(Date.now());
        const fetchImpl = jsonFetch([registryIndex()]);
        const markets = await discoverWith(fetchImpl);
        expect(markets).toHaveLength(1);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("falls back to a stale cache when the registry is unreachable", async () => {
        await seedCache(0);
        const fetchImpl = jsonFetch([new Error("network down")]);
        const markets = await discoverWith(fetchImpl);
        expect(markets).toHaveLength(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("clears the stale cache when the registry is reachable but emptied", async () => {
        await seedCache(0);
        const markets = await discoverWith(jsonFetch([{ ...registryIndex(), markets: [] }]));
        expect(markets).toHaveLength(0);
        expect((await cache())?.markets).toHaveLength(0);
    });

    it("refetches when a cached market is malformed", async () => {
        // a stored entry outlives the schema that wrote it
        await seedCache(Date.now(), [null as unknown as DiscoveredMarket]);
        const fetchImpl = jsonFetch([registryIndex()]);
        const markets = await discoverWith(fetchImpl);
        expect(markets).toHaveLength(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("fetches when the cache backend itself is unreadable", async () => {
        // a broken backend must degrade to a network fetch, never throw out
        const broken = Object.assign(new InMemoryAssetSwapRepository(), {
            getCachedMarkets: async () => {
                throw new Error("backend gone");
            },
        });
        const fetchImpl = jsonFetch([registryIndex()]);
        const markets = await discoverMarkets({
            network: "mutinynet",
            registryUrl: REGISTRY_URL,
            repository: broken,
            fetchImpl,
        });
        expect(markets).toHaveLength(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("refetches past a fresh cache when useCache is false, keeping the stale fallback", async () => {
        await seedCache(Date.now());
        const fetchImpl = jsonFetch([registryIndex()]);
        const markets = await discoverMarkets({
            network: "mutinynet",
            registryUrl: REGISTRY_URL,
            repository,
            fetchImpl,
            useCache: false,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(markets).toHaveLength(1);

        // useCache: false forces the refetch but must not disable the stale
        // fallback — an unreachable registry still serves the last known markets
        const downImpl = jsonFetch([new Error("network down")]);
        const served = await discoverMarkets({
            network: "mutinynet",
            registryUrl: REGISTRY_URL,
            repository,
            fetchImpl: downImpl,
            useCache: false,
        });
        expect(served).toHaveLength(1);
    });

    it("skips the cache entirely when no repository is given", async () => {
        const fetchImpl = jsonFetch([registryIndex()]);
        const opts = { network: "mutinynet" as const, registryUrl: REGISTRY_URL, fetchImpl };
        expect(await discoverMarkets(opts)).toHaveLength(1);
        expect(await discoverMarkets(opts)).toHaveLength(1);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});

describe("validatePlan", () => {
    const plan = (give: "base" | "quote", giveAmount: bigint) =>
        planOffer({ market: btcUsd, give, feedValue: 100000, giveAmount, safetyBps: 0 });

    it("accepts a plan within balance and limits", () => {
        expect(
            validatePlan(plan("base", BigInt(10_000)), BigInt(20_000), BigInt(330)),
        ).toBeUndefined();
    });

    it("flags insufficient balance", () => {
        expect(validatePlan(plan("base", BigInt(10_000)), BigInt(5_000), BigInt(330))).toBe(
            "insufficient-balance",
        );
    });

    it("flags amounts outside the market limits", () => {
        expect(validatePlan(plan("base", BigInt(500)), BigInt(20_000), BigInt(330))).toBe(
            "below-min",
        );
        expect(validatePlan(plan("base", BigInt(6_000_000)), BigInt(10_000_000), BigInt(330))).toBe(
            "above-max",
        );
    });

    it("enforces the card give-side floor the SDK limits omit", () => {
        // 700 sats pays out ~$0.70 — above the converted receive minimum ($0.50),
        // but below the card's 1,000-sat min_base_amount; the solver would reject
        // this at fill, so the maker must flag it up front
        expect(validatePlan(plan("base", BigInt(700)), BigInt(20_000), BigInt(330))).toBe(
            "below-min",
        );
    });

    it("flags a btc side below dust", () => {
        // giving quote: the received btc must be a viable VTXO
        const p = plan("quote", BigInt(152)); // -> 1515 sats, within limits
        expect(validatePlan(p, BigInt(1_000), BigInt(2_000))).toBe("below-dust");
        expect(validatePlan(p, BigInt(1_000), BigInt(330))).toBeUndefined();
    });

    it("skips the dust check when neither leg is BTC (#857)", () => {
        // both atomic sides sit under the sat dust number, but neither is sats:
        // asset deposits and fills ride the SDK's own dust carriers, so there is
        // no BTC leg to protect
        const p = planOffer({
            market: xauUsd,
            give: "base",
            feedValue: 1,
            giveAmount: BigInt(200),
            safetyBps: 0,
        });
        expect(validatePlan(p, BigInt(1_000), BigInt(330))).toBeUndefined();
    });

    it("picks the dust leg by asset id, not market orientation", () => {
        // a registry may publish BTC as the QUOTE asset; giving base then means
        // depositing the token, and dust must bound the received btc side
        const usdBtc: DiscoveredMarket = {
            ...btcUsd,
            pair: "USD/BTC",
            base_asset: btcUsd.quote_asset,
            quote_asset: btcUsd.base_asset,
            min_base_amount: btcUsd.min_quote_amount,
            max_base_amount: btcUsd.max_quote_amount,
            min_quote_amount: btcUsd.min_base_amount,
            max_quote_amount: btcUsd.max_base_amount,
            price_decimals: 0,
        };
        // 1 USD-cent -> 10 sats: 200 cents receives ~1994 sats (post-fee)
        const p = planOffer({
            market: usdBtc,
            give: "base",
            feedValue: 10,
            giveAmount: BigInt(200),
            safetyBps: 0,
        });
        // deposit atomic (200) is below the 330-sat dust number, but the btc leg
        // (~1994 sats) is fine — orientation-based selection would false-reject
        expect(validatePlan(p, BigInt(1_000), BigInt(330))).toBeUndefined();
        // and a genuinely sub-dust btc receive is still caught
        expect(validatePlan(p, BigInt(1_000), BigInt(2_500))).toBe("below-dust");
    });
});
