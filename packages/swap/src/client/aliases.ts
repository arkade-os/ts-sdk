/**
 * The alias layer: public ids down to the vocabulary discovery and RFQ speak.
 *
 * One way only: several CAIP-19 public ids can share one discovery leg, so there is no
 * round trip. The covenant identity is carried verbatim and does round-trip.
 *
 * The RFQ wire's `pair` (`<from-leg>-><to-leg>`, byte-compared and length-capped by the
 * solver) is built by the quote path, not here; a CAIP-19 id would break both.
 */
import { NETWORKS, isNetwork, type Network as IndexedNetwork } from "@arkade-os/solver-discovery";
import { BTC_ASSET_ID } from "../store";
import {
    ARKADE_ASSET_NAMESPACE,
    AssetIdError,
    btcOn,
    type AssetId,
    isAssetId,
    isBtcAsset,
    parseAssetId,
} from "./assetId";
import type { NetworkRef } from "./assetId";
import type { Corridor } from "./corridor";
import { UnsupportedRoute } from "./errors";

/** What discovery names a leg by: its corridor, and the asset id on it. */
export interface DiscoveryLeg {
    corridor: Corridor;
    /** `"btc"`, or the 68-hex Arkade asset identity. */
    assetId: string;
    /** Full CAIP-19 id used by solver-discovery's canonical market selector. */
    marketId: AssetId;
}

/**
 * A public id down to its discovery leg.
 *
 * @throws {@link UnsupportedRoute} for anything v2 cannot route, e.g. an `eip155:` id, or
 * a non-BTC asset on lightning or L1.
 */
export const toDiscoveryLeg = (id: AssetId): DiscoveryLeg => {
    const { rail, reference, assetNamespace, assetReference } = parseAssetId(id);
    const asset = `${assetNamespace}:${assetReference}`;
    const isBtc = isBtcAsset(id);
    if (!isBtc && rail !== "eip155" && (asset === "slip44:0" || asset === "slip44:1")) {
        // BTC's coin type is per network (`slip44:0` mainnet, `slip44:1` elsewhere). The other one
        // is a caller bug, refused here rather than quoted against a key no card carries.
        const expected = btcOn(rail, reference as NetworkRef);
        throw new UnsupportedRoute(`${id} is not BTC on ${reference}: BTC there is ${expected}`);
    }
    if (rail === "arkade") {
        if (isBtc) return { corridor: "arkade", assetId: BTC_ASSET_ID, marketId: id };
        if (assetNamespace === ARKADE_ASSET_NAMESPACE) {
            return { corridor: "arkade", assetId: assetReference, marketId: id };
        }
        throw new UnsupportedRoute(`the arkade corridor has no ${asset}`);
    }
    if (rail === "bolt11") {
        if (isBtc) return { corridor: "lightning", assetId: BTC_ASSET_ID, marketId: id };
        throw new UnsupportedRoute(`the lightning corridor carries BTC only, not ${asset}`);
    }
    if (rail === "bitcoin") {
        if (isBtc) return { corridor: "onchain", assetId: BTC_ASSET_ID, marketId: id };
        throw new UnsupportedRoute(`the onchain corridor carries BTC only, not ${asset}`);
    }
    throw new UnsupportedRoute(`no corridor serves ${id}`);
};

/** One registry row: what a ticker canonicalizes to. */
export interface RegisteredAsset {
    id: AssetId;
    /** The display ticker. Matched case-insensitively; never an identity. */
    ticker: string;
}

/** The table caller input is canonicalized against; the quote path fills it from discovery. */
export interface AssetAliasTable {
    /** The wallet's network. An id on any other network is not a candidate. */
    network: NetworkRef;
    assets: readonly RegisteredAsset[];
}

/**
 * The networks discovery publishes a market index for (core's set minus `testnet`). The
 * `satisfies` makes a rename on either side a compile error, not a silent "no index".
 */
export const INDEXED_NETWORKS = NETWORKS satisfies readonly NetworkRef[];

/**
 * Whether a market index can be fetched for `network`. `testnet` ids are valid but have
 * no published index; the quote path decides which error that becomes.
 */
export const isIndexedNetwork = (network: NetworkRef): network is IndexedNetwork =>
    isNetwork(network);

const networkOfRow = (row: RegisteredAsset): string => parseAssetId(row.id).reference;

/**
 * Caller input to a public id: an id passes through validated, a ticker is resolved
 * case-insensitively against the table on the wallet's network.
 *
 * @throws {@link AssetIdError} `ambiguous_alias` when a ticker matches more than one
 * asset: guessing between two `USDT`s sends the money to the wrong one.
 */
export const canonicalAssetId = (input: string, table: AssetAliasTable): AssetId => {
    if (isAssetId(input)) return input;
    const wanted = input.trim().toLowerCase();
    const matches = table.assets.filter(
        (row) => row.ticker.toLowerCase() === wanted && networkOfRow(row) === table.network,
    );
    if (matches.length === 0) {
        throw new AssetIdError(
            "unknown_alias",
            input,
            `no asset with that ticker on ${table.network}`,
        );
    }
    // A registry listing the same id twice is duplication, not ambiguity.
    const distinct = new Set(matches.map((row) => row.id));
    if (distinct.size > 1) {
        throw new AssetIdError(
            "ambiguous_alias",
            input,
            `${distinct.size} assets on ${table.network} answer to that ticker: ${[...distinct].join(", ")}`,
        );
    }
    return matches[0].id;
};
