import {
    bestMarket,
    discover,
    isNetwork,
    sideLimits,
    type DiscoveredMarket,
    type LocalCardInput,
    type Network,
    type OfferPlan,
    type Side,
} from "@arkade-os/solver-discovery";
import { isSubdust } from "@arkade-os/sdk";
import type { AssetSwapRepository, MarketsCacheEntry } from "./repository";
import { BTC_ASSET_ID } from "./store";

/** Shared quote options so every quote path agrees.
 * No safety margin on top of the market fee: pricing drift between quote
 * and fill is the solver's risk to manage, not the maker's to prepay. */
export const QUOTE_OPTIONS = { safetyBps: 0 } as const;

/** Feed fetcher with a short per-URL TTL cache. A quote UI refetches the
 * market's price feed on every debounced keystroke, and public feeds
 * (CoinGecko) rate-limit that burst hard enough that big amounts reliably die
 * as "Quote unavailable" mid-typing — one feed value per TTL window is fresh
 * enough for a preview whose rate is re-checked at fill anyway.
 * ponytail: no stale-serve when the fetch itself fails; add one if feeds
 * flake beyond the TTL window (cap the staleness — the feed value becomes
 * the covenant floor, so an old price must never price a real offer).
 * Keyed on the request URL, so it assumes a market's feed URL is stable and
 * amount-invariant (true today); a cache-busting nonce would silently make it
 * a no-op — the flat-feedCalls swap test guards against that regressing. */
export const makeCachedFeedFetch = (
    ttlMs = 30_000,
    fetchImpl: typeof fetch = fetch,
): typeof fetch => {
    const cache = new Map<string, { at: number; body: string }>();
    return async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const hit = cache.get(url);
        if (hit && Date.now() - hit.at < ttlMs) return new Response(hit.body);
        const response = await fetchImpl(input, init);
        // caching is best effort: a body read that fails mid-stream must not
        // take the live response down with it (the caller would see an internal
        // error instead of the quote it actually got)
        if (response.ok) {
            try {
                cache.set(url, { at: Date.now(), body: await response.clone().text() });
            } catch {
                // unreadable body: serve the response uncached
            }
        }
        return response;
    };
};

const MARKETS_CACHE_TTL_MS = 60 * 60 * 1000;

const isMarketShaped = (m: unknown): m is DiscoveredMarket => {
    const market = m as DiscoveredMarket | null;
    return Boolean(
        market &&
            typeof market.pair === "string" &&
            market.base_asset &&
            typeof market.base_asset.id === "string" &&
            market.quote_asset &&
            typeof market.quote_asset.id === "string" &&
            typeof market.quote_asset.decimals === "number",
    );
};

// a missing, malformed, or unreadable cache reads as a miss; the refetch
// overwrites it. Shape is re-checked on read because a stored entry outlives
// the schema that wrote it.
const readMarketsCache = async (
    repository: AssetSwapRepository,
    network: Network,
    registry: string,
): Promise<MarketsCacheEntry | undefined> => {
    try {
        const entry = await repository.getCachedMarkets(network, registry);
        if (!Array.isArray(entry?.markets) || typeof entry?.fetchedAt !== "number")
            return undefined;
        return entry.markets.every(isMarketShaped) ? entry : undefined;
    } catch {
        return undefined;
    }
};

export interface DiscoverMarketsOptions {
    network: Network;
    /** The network's solver registry index URL; no registry means no markets. */
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
    /** `false` forces a refetch past a fresh cache (a user-triggered reload).
     * It does not disable the stale-cache fallback: an unreachable registry
     * still serves the last known markets rather than none. */
    useCache?: boolean;
}

/**
 * Markets from the network's solver registry; [] when none is configured.
 * Registry content changes rarely, so results are cached for an hour and a
 * stale cache backstops an unreachable registry (quotes stay live either way).
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
    if (!registry || !isNetwork(network)) return [];
    const cached = repository && (await readMarketsCache(repository, network, registry));
    if (useCache && cached && Date.now() - cached.fetchedAt < MARKETS_CACHE_TTL_MS)
        return cached.markets;
    const { markets, sources, warnings } = await discover({
        registries: [registry],
        localCards,
        network,
        fetchImpl,
    });
    if (warnings.length) logger?.("solver discovery:", ...warnings);
    // an unreachable registry (fetch/validation failure) falls back to the stale
    // cache; a reachable registry is authoritative even when it emptied out
    const reachable = sources.some((source) => source.ok);
    if (!reachable && cached) return cached.markets;
    if (reachable && repository) {
        try {
            await repository.saveCachedMarkets(network, registry, {
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
 * disabled (max = "0"). */
export const findMarket = (
    markets: DiscoveredMarket[],
    fromId: string,
    toId: string,
): { market: DiscoveredMarket | null; give: Side } | undefined => {
    if (fromId === toId) return undefined;
    const givingBase = bestMarket(markets, { baseId: fromId, quoteId: toId, wantSide: "quote" });
    if (givingBase) return { market: givingBase, give: "base" };
    return {
        market: bestMarket(markets, { baseId: toId, quoteId: fromId, wantSide: "base" }),
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

/** Validate a plan against the maker's balance and the server dust limit. */
export const validatePlan = (
    plan: OfferPlan,
    giveBalance: bigint,
    dust: bigint,
): PlanError | undefined => {
    if (plan.deposit.atomic > giveBalance) return "insufficient-balance";
    // limits bound the receive side; null bounds mean the solver cannot pay it out
    const { min, max, withinLimits } = plan.limits;
    if (!min || !max) return "side-disabled";
    // the SDK's plan.limits only covers the receive side, but the market card
    // bounds BOTH sides — enforce the give side (atomic units of the deposit
    // asset) or the solver rejects the offer at fill time. sideLimits reads a
    // disabled or malformed bound as null, so a bad feed fails safe here.
    const giveLimits = sideLimits(plan.market, plan.give);
    if (!giveLimits) return "side-disabled";
    if (plan.deposit.atomic < giveLimits.min) return "below-min";
    if (plan.deposit.atomic > giveLimits.max) return "above-max";
    if (!withinLimits) return plan.receive.atomic < min.atomic ? "below-min" : "above-max";
    // a BTC side must survive as a VTXO — picked by asset id, not market
    // orientation, since a registry may publish BTC as base or quote. An
    // asset↔asset plan has no BTC leg to protect: both sides ride the SDK's
    // own dust-sat carriers.
    const depositIsBtc = plan.deposit.asset.id === BTC_ASSET_ID;
    const receiveIsBtc = plan.receive.asset.id === BTC_ASSET_ID;
    if (depositIsBtc || receiveIsBtc) {
        const btcSide = depositIsBtc ? plan.deposit.atomic : plan.receive.atomic;
        if (isSubdust(btcSide, dust)) return "below-dust";
    }
    return undefined;
};
