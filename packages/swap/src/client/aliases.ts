/**
 * The alias layer: public ids down to the vocabulary discovery and RFQ speak.
 *
 * One way only. A public id is CAIP-19 and carries its rail; discovery keeps
 * chain-relative leg keys (a `Corridor` plus an `AssetInfo.id` of `"btc"` or
 * the 68-hex identity), and the two are not in bijection — several public ids
 * can share one discovery asset. Promising a round trip through it was the
 * mistake the earlier Q5 shape made; what does round-trip byte-for-byte is the
 * covenant identity itself, which this layer carries verbatim.
 *
 * Registry ratification of the CAIP form (Q11) does not block any of this: if
 * solver-registry adopts it, the table below shortens.
 *
 * The RFQ wire's `pair` string is not built here. It is `<from-leg>-><to-leg>`,
 * byte-compared by the solver and length-capped, and the quote path's request
 * builder owns it — a CAIP-19 id would both break the comparison and overrun
 * the cap.
 */
import { NETWORKS, isNetwork, type Network as IndexedNetwork } from "@arkade-os/solver-discovery";
import { BTC_ASSET_ID } from "../store";
import {
    ARKADE_ASSET_NAMESPACE,
    AssetIdError,
    BTC_ASSET_PART,
    type AssetId,
    isAssetId,
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
}

/**
 * A public id down to its discovery leg.
 *
 * Total over the ids v2 can route and refusing everything else: an `eip155:` id
 * is grammar-valid and unserved (§9 is deferred), and a non-BTC asset on
 * lightning or L1 names a corridor that carries only BTC.
 */
export const toDiscoveryLeg = (id: AssetId): DiscoveryLeg => {
    const { rail, assetNamespace, assetReference } = parseAssetId(id);
    const asset = `${assetNamespace}:${assetReference}`;
    if (rail === "arkade") {
        if (asset === BTC_ASSET_PART) return { corridor: "arkade", assetId: BTC_ASSET_ID };
        if (assetNamespace === ARKADE_ASSET_NAMESPACE) {
            return { corridor: "arkade", assetId: assetReference };
        }
        throw new UnsupportedRoute(`the arkade corridor has no ${asset}`);
    }
    // Lightning and L1 carry BTC and nothing else — there is no leg name for
    // an asset on them, so this is a refusal rather than a lookup miss.
    if (rail === "bolt11") {
        if (asset === BTC_ASSET_PART) return { corridor: "lightning", assetId: BTC_ASSET_ID };
        throw new UnsupportedRoute(`the lightning corridor carries BTC only, not ${asset}`);
    }
    if (rail === "bitcoin") {
        if (asset === BTC_ASSET_PART) return { corridor: "onchain", assetId: BTC_ASSET_ID };
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

/**
 * The table caller input is canonicalized against.
 *
 * Injected rather than fetched: M1 owns no network layer, and the quote path
 * fills this from discovery when it has one.
 */
export interface AssetAliasTable {
    /** The wallet's network. An id on any other network is not a candidate. */
    network: NetworkRef;
    assets: readonly RegisteredAsset[];
}

/**
 * The networks discovery publishes a market index for, restated as network
 * references.
 *
 * The two vocabularies are spelled identically and differ only in that core
 * carries `testnet` and discovery does not, so the narrowing is set membership
 * and nothing more. The `satisfies` is the pin: a rename on either side fails
 * to compile here instead of degrading into a silent "no index for this
 * network".
 */
export const INDEXED_NETWORKS = NETWORKS satisfies readonly NetworkRef[];

/**
 * Whether a market index can be fetched for `network`.
 *
 * Partial by construction, and `testnet` is the member outside it: an asset on
 * testnet is nameable — `arkade:testnet/slip44:0` is a valid id — there is
 * simply no published index to price it against. Which error that becomes is
 * the quote path's call, not this layer's.
 */
export const isIndexedNetwork = (network: NetworkRef): network is IndexedNetwork =>
    isNetwork(network);

const networkOfRow = (row: RegisteredAsset): string => parseAssetId(row.id).reference;

/**
 * Caller input to a public id: an id passes through validated, a ticker is
 * resolved against the table.
 *
 * Ticker matching is case-insensitive and scoped to the wallet's network, and a
 * ticker that matches more than one asset on that network is refused rather
 * than guessed — two assets called `USDT` are exactly the case where guessing
 * sends the money to the wrong one.
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
    // Distinct rows may still name one asset — a registry listing the same id
    // twice is duplication, not ambiguity.
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
