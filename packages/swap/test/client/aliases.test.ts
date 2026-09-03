import { asset } from "@arkade-os/sdk";
import { describe, expect, it } from "vitest";
import { BTC_ASSET_ID } from "../../src/store";
import { arkadeAsset, btcOn } from "../../src/client/assetId";
import { type AssetAliasTable, canonicalAssetId, toDiscoveryLeg } from "../../src/client/aliases";

const NETWORK = "regtest";
const issued = (hex: string): asset.AssetId => asset.AssetId.fromString(hex);

const USD = arkadeAsset(NETWORK, issued(`${"11".repeat(32)}0000`));
const CHF = arkadeAsset(NETWORK, issued(`${"22".repeat(32)}0000`));

const table: AssetAliasTable = {
    network: NETWORK,
    assets: [
        { id: btcOn("arkade", NETWORK), ticker: "BTC" },
        { id: USD, ticker: "USD" },
        { id: CHF, ticker: "CHF" },
        // another network's listing, so the scoping rule has something to drop
        { id: arkadeAsset("bitcoin", issued(`${"33".repeat(32)}0000`)), ticker: "USD" },
    ],
};

describe("public ids down to discovery legs", () => {
    it("covers every leg of the four implemented routes", () => {
        expect(toDiscoveryLeg(btcOn("arkade", NETWORK))).toEqual({
            corridor: "arkade",
            assetId: BTC_ASSET_ID,
        });
        expect(toDiscoveryLeg(btcOn("bolt11", NETWORK))).toEqual({
            corridor: "lightning",
            assetId: BTC_ASSET_ID,
        });
        expect(toDiscoveryLeg(btcOn("bitcoin", NETWORK))).toEqual({
            corridor: "onchain",
            assetId: BTC_ASSET_ID,
        });
        expect(toDiscoveryLeg(USD)).toEqual({
            corridor: "arkade",
            assetId: `${"11".repeat(32)}0000`,
        });
    });

    it("carries the covenant identity through byte for byte", () => {
        const V = asset.ASSET_ID_VECTORS;
        for (const v of V.valid) {
            const leg = toDiscoveryLeg(arkadeAsset(NETWORK, issued(v.asset_id_hex)));
            expect(leg.assetId, `identity drifted (${v.label})`).toBe(v.asset_id_hex);
            expect(asset.AssetId.fromString(leg.assetId).toString()).toBe(v.asset_id_hex);
        }
    });

    it("is rail-blind about BTC and rail-specific about everything else", () => {
        // Three public ids, one discovery leg per corridor: the alias layer
        // runs one way, and the reverse is not a function.
        const legs = (["arkade", "bolt11", "bitcoin"] as const).map((rail) =>
            toDiscoveryLeg(btcOn(rail, NETWORK)),
        );
        expect(new Set(legs.map((l) => l.assetId))).toEqual(new Set([BTC_ASSET_ID]));
        expect(legs.map((l) => l.corridor)).toEqual(["arkade", "lightning", "onchain"]);
    });

    it.each([
        [
            "an asset on lightning, which carries BTC only",
            `bolt11:${NETWORK}/asset:${"aa".repeat(34)}` as const,
        ],
        ["an asset on L1", `bitcoin:${NETWORK}/asset:${"aa".repeat(34)}` as const],
        ["an unknown namespace on arkade", `arkade:${NETWORK}/slip44:60` as const],
        [
            "an eip155 id, which is grammar-valid and unserved",
            "eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7" as const,
        ],
    ])("refuses %s", (_label, id) => {
        expect(() => toDiscoveryLeg(id)).toThrowError(
            expect.objectContaining({ name: "UnsupportedRoute" }),
        );
    });
});

describe("caller input to a public id", () => {
    it("passes an id through", () => {
        expect(canonicalAssetId(btcOn("arkade", NETWORK), table)).toBe(btcOn("arkade", NETWORK));
    });

    it("canonicalises a ticker case-insensitively", () => {
        expect(canonicalAssetId("btc", table)).toBe(btcOn("arkade", NETWORK));
        expect(canonicalAssetId("BTC", table)).toBe(btcOn("arkade", NETWORK));
        expect(canonicalAssetId("uSd", table)).toBe(USD);
    });

    it("scopes tickers to the wallet's network", () => {
        // The mainnet USD row is in the table and must not answer here.
        expect(canonicalAssetId("USD", table)).toBe(USD);
    });

    it("rejects a collision rather than guessing", () => {
        const colliding: AssetAliasTable = {
            network: NETWORK,
            assets: [...table.assets, { id: CHF, ticker: "USD" }],
        };
        expect(() => canonicalAssetId("USD", colliding)).toThrowError(
            expect.objectContaining({ name: "AssetIdError", reason: "ambiguous_alias" }),
        );
    });

    it("tolerates a registry listing one asset twice", () => {
        const duplicated: AssetAliasTable = {
            network: NETWORK,
            assets: [...table.assets, { id: USD, ticker: "usd" }],
        };
        expect(canonicalAssetId("USD", duplicated)).toBe(USD);
    });

    it("refuses a ticker nothing on this network answers to", () => {
        expect(() => canonicalAssetId("USDT", table)).toThrowError(
            expect.objectContaining({ name: "AssetIdError", reason: "unknown_alias" }),
        );
    });
});
