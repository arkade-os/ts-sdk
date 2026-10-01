/**
 * Quoting: solver discovery and the pricing guardrails around a plan.
 *
 * The quote resolves client-side from the solver's published market card (price feed
 * and fee), not over a relay round trip. The card commits a solver to a price; only a
 * fill commits it to this swap, so nothing here is signed and no inventory is reserved.
 */
import {
    bestMarket,
    discover,
    isNetwork,
    marketLegKey,
    registryIndexUrl,
    sideLimits,
    type DiscoveredMarket,
    type LocalCardInput,
    type Network,
    type OfferPlan,
    type Side,
} from "@arkade-os/solver-discovery";
import { isSubdust } from "@arkade-os/sdk";
import type { AssetSwapRepository, MarketsCacheEntry } from "./repository";
import { marketAssetId } from "./marketShape";
import { BTC_ASSET_ID } from "./store";

/** Shared quote options so every quote path agrees.
 * No safety margin on top of the market fee: pricing drift between quote
 * and fill is the solver's risk to manage, not the user's to prepay.
 */
export const QUOTE_OPTIONS = { safetyBps: 0 } as const;

/** Feed fetcher with a short per-URL TTL cache: a quote UI refetches the feed on every
 * debounced keystroke, and public feeds (CoinGecko) rate-limit that burst. The rate is
 * re-checked at fill anyway.
 * ponytail: no stale-serve when the fetch itself fails; add one if feeds
 * flake beyond the TTL window (cap the staleness — the feed value becomes
 * the covenant floor, so an old price must never price a real offer).
 * Assumes a market's feed URL is stable and amount-invariant; a cache-busting nonce
 * would silently make this a no-op (guarded by the flat-feedCalls swap test).
 */
export const makeCachedFeedFetch = (
    ttlMs = 30_000,
    fetchImpl: typeof fetch = fetch,
): typeof fetch => {
    const cache = new Map<string, { at: number; body: string }>();
    // Sent-but-unanswered requests, so a burst inside one round trip collapses to a
    // single upstream call (the cache alone only dedups after the first response).
    const inflight = new Map<string, Promise<string | undefined>>();
    return async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const hit = cache.get(url);
        if (hit) {
            if (Date.now() - hit.at < ttlMs) return new Response(hit.body);
            cache.delete(url); // expired: drop it rather than retain every body seen
        }
        const pending = inflight.get(url);
        if (pending) {
            const body = await pending;
            // undefined: that response was not cacheable; make our own request
            if (body !== undefined) return new Response(body);
        }

        let settle: (body: string | undefined) => void = () => {};
        inflight.set(
            url,
            new Promise<string | undefined>((resolve) => {
                settle = resolve;
            }),
        );
        try {
            const response = await fetchImpl(input, init);
            // Best effort: a failed body read must not take the live response down with it.
            let body: string | undefined;
            if (response.ok) {
                try {
                    body = await response.clone().text();
                    cache.set(url, { at: Date.now(), body });
                } catch {
                    body = undefined; // unreadable body: serve the response uncached
                }
            }
            settle(body);
            return response;
        } catch (err) {
            settle(undefined); // waiters make their own attempt rather than inheriting the failure
            throw err;
        } finally {
            inflight.delete(url);
        }
    };
};

/** How long a discovered market set is reused. Shared with v2 discovery so the two
 * paths cannot drift into different answers. */
export const MARKETS_CACHE_TTL_MS = 60 * 60 * 1000;

const isMarketShaped = (m: unknown): m is DiscoveredMarket => {
    const market = m as Partial<DiscoveredMarket> | null;
    if (!market) return false;
    return (
        typeof market.base_asset?.id === "string" &&
        typeof market.quote_asset?.id === "string" &&
        typeof market.quote_asset.decimals === "number"
    );
};

// A missing, malformed, or unreadable cache reads as a miss. Shape is re-checked on
// read because a stored entry outlives the schema that wrote it.
const readMarketsCache = async (
    repository: AssetSwapRepository,
    network: Network,
    registry: string,
): Promise<MarketsCacheEntry | undefined> => {
    try {
        const entry = await repository.getCachedMarkets(network, registry);
        if (!Array.isArray(entry?.markets) || typeof entry?.fetchedAt !== "number")
            return undefined;
        const markets = entry.markets.filter(isMarketShaped);
        // An empty cache is authoritative. A non-empty cache with no readable
        // markets is malformed and should be replaced by a fresh fetch.
        if (entry.markets.length > 0 && markets.length === 0) return undefined;
        return { ...entry, markets };
    } catch {
        return undefined;
    }
};

export interface DiscoverMarketsOptions {
    network: Network;
    /** Overrides the network's default registry. `undefined` follows
     * `@arkade-os/solver-discovery`'s per-network default (never hardcoded here). */
    registryUrl: string | undefined;
    /** Backs the 1-hour markets cache and its stale fallback. Omit for a
     * one-shot discovery that always hits the registry. */
    repository?: AssetSwapRepository;
    /** Locally pinned solver cards to merge with the registry's markets. */
    localCards?: LocalCardInput[];
    /** Receives discovery warnings (stale index, skipped cards, …). */
    logger?: (...args: unknown[]) => void;
    /** Custom fetch (tests, mobile runtimes). Defaults to global fetch.
     * ponytail: no request deadline here — a caller that needs one wraps its
     * own fetchImpl with an AbortSignal; add one if a hung registry ever
     * strands discovery in practice. */
    fetchImpl?: typeof fetch;
    /** `false` forces a refetch past a fresh cache. The stale-cache fallback for an
     * unreachable registry still applies. */
    useCache?: boolean;
}

/**
 * Markets from this network's solver registry, cached for an hour, with a stale cache
 * backstopping an unreachable registry. Only an unrecognised network yields [].
 */
export const discoverMarkets = async (
    options: DiscoverMarketsOptions,
): Promise<DiscoveredMarket[]> => {
    const {
        network,
        registryUrl: registry,
        repository,
        localCards = [],
        logger,
        fetchImpl,
        useCache = true,
    } = options;
    if (!isNetwork(network)) return [];
    // undefined follows the default ([] would opt out); the cache key is the URL
    // `discover()` actually reads, default included.
    const registries = registry ? [registry] : undefined;
    const registryKey = registries?.[0] ?? registryIndexUrl(network);
    const cached = repository && (await readMarketsCache(repository, network, registryKey));
    if (useCache && cached && Date.now() - cached.fetchedAt < MARKETS_CACHE_TTL_MS)
        return cached.markets;
    const { markets, sources, warnings } = await discover({
        registries,
        localCards,
        network,
        fetchImpl,
    });
    if (warnings.length) logger?.("solver discovery:", ...warnings);
    // A reachable registry is authoritative even when empty.
    const reachable = sources.some((source) => source.ok);
    if (!reachable && cached) return cached.markets;
    if (reachable && repository) {
        try {
            await repository.saveCachedMarkets(network, registryKey, {
                markets,
                fetchedAt: Date.now(),
            });
        } catch {
            // best effort: a lost cache write just means a refetch
        }
    }
    return markets;
};

/** Best market for a from/to pair, in either orientation. `give` is the side
 * the sender deposits; `wantSide` skips markets whose receive side is
 * disabled (max = "0").
 */
export const findMarket = (
    markets: DiscoveredMarket[],
    fromId: string,
    toId: string,
): { market: DiscoveredMarket | null; give: Side } | undefined => {
    if (fromId === toId) return undefined;
    const resolveMarketId = (id: string): string => {
        for (const market of markets) {
            for (const side of ["base", "quote"] as const) {
                const asset = side === "base" ? market.base_asset : market.quote_asset;
                if (asset.id === id) return marketLegKey(market, side);
                const canonical = marketAssetId(market, side) ?? "";
                const matchesBtc =
                    id === BTC_ASSET_ID && /^arkade:[^/]+\/slip44:(?:0|1)$/.test(canonical);
                const matchesAsset =
                    /^[0-9a-f]{68}$/.test(id) && canonical.endsWith(`/asset:${id}`);
                if (matchesBtc || matchesAsset) return marketLegKey(market, side);
            }
        }
        return id;
    };
    const resolvedFrom = resolveMarketId(fromId);
    const resolvedTo = resolveMarketId(toId);
    const givingBase = bestMarket(markets, {
        baseId: resolvedFrom,
        quoteId: resolvedTo,
        wantSide: "quote",
    });
    if (givingBase) return { market: givingBase, give: "base" };
    return {
        market: bestMarket(markets, {
            baseId: resolvedTo,
            quoteId: resolvedFrom,
            wantSide: "base",
        }),
        give: "quote",
    };
};

// ponytail: no preFeeDisplayRate here — the pre-fee Rate-row derivation is
// display-only; lift it from the wallet if a second consumer needs it

export type PlanError =
    | "insufficient-balance"
    | "side-disabled"
    | "below-min"
    | "above-max"
    | "below-dust";

/** Validate a plan against the user's balance and the server dust limit.*/
export const validatePlan = (
    plan: OfferPlan,
    giveBalance: bigint,
    dust: bigint,
): PlanError | undefined => {
    if (plan.deposit.atomic > giveBalance) return "insufficient-balance";
    // null receive-side bounds mean the solver cannot pay it out
    const { min, max, withinLimits } = plan.limits;
    if (!min || !max) return "side-disabled";
    // plan.limits covers only the receive side, but the card bounds BOTH; an unchecked
    // give side is rejected at fill. A malformed bound reads as null, failing safe.
    const giveLimits = sideLimits(plan.market, plan.give);
    if (!giveLimits) return "side-disabled";
    if (plan.deposit.atomic < giveLimits.min) return "below-min";
    if (plan.deposit.atomic > giveLimits.max) return "above-max";
    if (!withinLimits) return plan.receive.atomic < min.atomic ? "below-min" : "above-max";
    // A BTC side must survive as a VTXO; picked by asset id since BTC may be base or
    // quote. Asset↔asset plans ride the SDK's own dust-sat carriers.
    const depositIsBtc = plan.deposit.asset.id === BTC_ASSET_ID;
    const receiveIsBtc = plan.receive.asset.id === BTC_ASSET_ID;
    if (depositIsBtc || receiveIsBtc) {
        const btcSide = depositIsBtc ? plan.deposit.atomic : plan.receive.atomic;
        if (isSubdust(btcSide, dust)) return "below-dust";
    }
    return undefined;
};
