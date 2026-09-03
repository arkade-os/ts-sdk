/**
 * The alias table, filled from discovery.
 *
 * M1 declared {@link AssetAliasTable} and left it injected: the alias layer owns
 * no network, and the table's only real source is the market index, which is
 * this milestone's. So this is the inverse of `toDiscoveryLeg` -- a card's
 * corridor and `AssetInfo` back up to the public id a caller may write, plus the
 * ticker that id answers to.
 *
 * Tickers are display metadata on a card and identity nowhere, which is why the
 * table carries both and `canonicalAssetId` refuses a ticker that names two
 * assets rather than picking one. Rows are deduplicated by id and ticker, so a
 * ticker listed by nine solvers for the same asset is one row and not an
 * ambiguity.
 */
import { marketCorridor, type DiscoveredMarket, type Side } from "@arkade-os/solver-discovery";
import { BTC_ASSET_ID } from "../store";
import type { AssetAliasTable, RegisteredAsset } from "./aliases";
import { ARKADE_ASSET_NAMESPACE, type AssetId, type NetworkRef, type Rail, btcOn } from "./assetId";
import { railOfCorridor, type Corridor } from "./corridor";

/** The 68-lowercase-hex Arkade issuance identity, as a card spells it. */
const ARKADE_ASSET_IDENTITY = /^[0-9a-f]{68}$/;

/**
 * The public id for one side of a card.
 *
 * `undefined` where the pair is not expressible as a public id: an
 * arkade-issued asset on lightning or L1, which no corridor carries, and an id
 * that is neither BTC nor the identity form.
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
        const id = publicAssetId(marketCorridor(card, side), info.id, network);
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
 * Q12 gives BTC one id per rail, so `"BTC"` names three assets the moment a
 * snapshot carries a corridor market — and the alias layer refuses a colliding
 * ticker rather than guessing, which is the right rule and would make the
 * spec's own `exchange({ give: "BTC", ... })` unresolvable if the table were
 * consulted whole. A ticker is therefore resolved on the leg's own rail: the
 * leg's corridor is already fixed by the destination, by `via`, or by being the
 * wallet's side, so the scope is a fact rather than a preference. Collisions
 * WITHIN a rail — two arkade assets both called `USDT` — still refuse, which is
 * the case the rule exists for.
 */
export const scopedToRail = (table: AssetAliasTable, rail: Rail): AssetAliasTable => ({
    network: table.network,
    assets: table.assets.filter((row) => row.id.startsWith(`${rail}:`)),
});
