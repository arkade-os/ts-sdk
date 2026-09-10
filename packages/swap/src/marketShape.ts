import type { Side } from "@arkade-os/solver-discovery";

export const MARKET_CORRIDORS = ["arkade", "bolt11", "bitcoin", "eip155"] as const;
export type MarketCorridor = (typeof MARKET_CORRIDORS)[number];

type AssetLike = { id?: unknown; caip19_id?: unknown; ticker?: unknown };
export type MarketLike = {
    base_asset?: unknown;
    quote_asset?: unknown;
    base_corridor?: unknown;
    quote_corridor?: unknown;
};

const LEGACY_CORRIDORS: Record<string, MarketCorridor> = {
    arkade: "arkade",
    lightning: "bolt11",
    onchain: "bitcoin",
    eip155: "eip155",
};

const assetOf = (market: MarketLike, side: Side): AssetLike | undefined =>
    (side === "base" ? market.base_asset : market.quote_asset) as AssetLike | undefined;

export const marketAssetId = (market: MarketLike, side: Side): string | undefined => {
    const asset = assetOf(market, side);
    if (typeof asset?.caip19_id === "string") return asset.caip19_id;
    return typeof asset?.id === "string" ? asset.id : undefined;
};

const chainNamespaceOf = (id: string | undefined): string | undefined => {
    if (id === undefined) return undefined;
    const slash = id.indexOf("/");
    const colon = id.indexOf(":");
    return slash === -1 || colon === -1 || colon > slash ? undefined : id.slice(0, colon);
};

export const marketCorridor = (market: MarketLike, side: Side): MarketCorridor => {
    const namespace = chainNamespaceOf(marketAssetId(market, side));
    if (namespace !== undefined) {
        return (MARKET_CORRIDORS as readonly string[]).includes(namespace)
            ? (namespace as MarketCorridor)
            : "arkade";
    }
    const legacy = side === "base" ? market.base_corridor : market.quote_corridor;
    return typeof legacy === "string" ? (LEGACY_CORRIDORS[legacy] ?? "arkade") : "arkade";
};

export const isRfqMarket = (market: MarketLike): boolean =>
    marketCorridor(market, "base") !== "arkade" || marketCorridor(market, "quote") !== "arkade";

const sideLabel = (market: MarketLike, side: Side): string => {
    const ticker = assetOf(market, side)?.ticker;
    const label = typeof ticker === "string" && ticker.length > 0 ? ticker : "?";
    const corridor = marketCorridor(market, side);
    return corridor === "arkade" ? label : `${corridor}:${label}`;
};

export const marketPairLabel = (market: MarketLike): string =>
    `${sideLabel(market, "base")}/${sideLabel(market, "quote")}`;
