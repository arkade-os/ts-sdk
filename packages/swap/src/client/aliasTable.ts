/**
 * The alias table, filled from discovery: the inverse of `toDiscoveryLeg`, mapping a card's
 * corridor and `AssetInfo` back to the public id a caller may write, plus its ticker.
 *
 * Tickers are display metadata, never identity, so `canonicalAssetId` refuses a ticker naming two
 * assets. Rows dedupe by id and ticker, so nine solvers listing one asset is one row.
 */
import type { DiscoveredMarket, Side } from "@arkade-os/solver-discovery";
import { BTC_ASSET_ID } from "../store";
import { marketAssetId, marketCorridor } from "../marketShape";
import type { AssetAliasTable, RegisteredAsset } from "./aliases";
import {
    ARKADE_ASSET_NAMESPACE,
    type AssetId,
    type NetworkRef,
    type Rail,
    btcOn,
    isAssetId,
} from "./assetId";
import { corridorOfRail, railOfCorridor, type Corridor } from "./corridor";

/** The 68-lowercase-hex Arkade issuance identity, as a card spells it. */
const ARKADE_ASSET_IDENTITY = /^[0-9a-f]{68}$/;

/**
 * The public id for one side of a card, or `undefined` when not expressible: an arkade-issued
 * asset on lightning or L1, or an id that is neither BTC nor the identity form.
 */
export const publicAssetId = (
    corridor: Corridor,
    assetId: string,
    network: NetworkRef,
): AssetId | undefined => {
    const rail = railOfCorridor(corridor);
    if (assetId === BTC_ASSET_ID) return btcOn(rail, network);
    if (rail !== "arkade") return undefined;
    if (!ARKADE_ASSET_IDENTITY.test(assetId)) return undefined;
    return `arkade:${network}/${ARKADE_ASSET_NAMESPACE}:${assetId}`;
};

/** Every asset the snapshot names, as caller-writable ids and their tickers. */
export const aliasTableFrom = (
    markets: readonly DiscoveredMarket[],
    network: NetworkRef,
): AssetAliasTable => {
    const rows = new Map<string, RegisteredAsset>();
    const add = (card: DiscoveredMarket, side: Side): void => {
        const info = side === "base" ? card.base_asset : card.quote_asset;
        const corridor = corridorOfRail(marketCorridor(card, side));
        if (corridor === undefined) return;
        const canonical = marketAssetId(card, side);
        const id =
            canonical !== undefined && isAssetId(canonical)
                ? canonical
                : publicAssetId(corridor, info.id, network);
        if (id === undefined || typeof info.ticker !== "string" || info.ticker === "") return;
        rows.set(`${id} ${info.ticker.toLowerCase()}`, { id, ticker: info.ticker });
    };
    for (const card of markets) {
        add(card, "base");
        add(card, "quote");
    }
    return { network, assets: [...rows.values()] };
};

/**
 * The table narrowed to one rail.
 *
 * BTC has one id per rail (Q12), so a whole-table lookup of `"BTC"` would collide and refuse. The
 * leg's rail is already fixed (by destination, `via`, or being the wallet's side), so resolving on
 * it is a fact, not a preference. Collisions within a rail (two arkade `USDT`s) still refuse.
 */
export const scopedToRail = (table: AssetAliasTable, rail: Rail): AssetAliasTable => ({
    network: table.network,
    assets: table.assets.filter((row) => row.id.startsWith(`${rail}:`)),
});
