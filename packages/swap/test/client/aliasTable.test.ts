import { describe, expect, it } from "vitest";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import { aliasTableFrom, scopedToRail } from "../../src/client/aliasTable";
import { canonicalAssetId } from "../../src/client/aliases";
import { lightningCard, spotCard } from "./fixtures";

describe("the alias table across card schemas", () => {
    it("reads both canonical card ids and legacy index ids", () => {
        const canonical = {
            ...lightningCard,
            pair: undefined,
            base_corridor: undefined,
            quote_corridor: undefined,
            base_asset: {
                ...lightningCard.base_asset,
                id: "arkade:regtest/slip44:1",
            },
            quote_asset: {
                ...lightningCard.quote_asset,
                id: "bolt11:regtest/slip44:1",
            },
        } as DiscoveredMarket;

        expect(aliasTableFrom([canonical], "regtest").assets).toEqual([
            { id: "arkade:regtest/slip44:1", ticker: "BTC" },
            { id: "bolt11:regtest/slip44:1", ticker: "BTC" },
        ]);
        expect(aliasTableFrom([lightningCard], "regtest").assets).toEqual([
            { id: "arkade:regtest/slip44:1", ticker: "BTC" },
            { id: "bolt11:regtest/slip44:1", ticker: "BTC" },
        ]);
    });

    it("names BTC once when a legacy card and a CAIP-19 card list it side by side", () => {
        // Mutinynet's registry: the lightning card spells BTC `btc`, the asset card carries
        // `caip19_id: "arkade:mutinynet/slip44:1"`. Both must land on the same row, or "BTC"
        // answers to two ids and refuses as ambiguous.
        const caipCard = {
            ...spotCard,
            base_asset: { ...spotCard.base_asset, caip19_id: "arkade:mutinynet/slip44:1" },
        } as DiscoveredMarket;
        const table = aliasTableFrom([lightningCard, caipCard], "mutinynet");

        expect(canonicalAssetId("BTC", scopedToRail(table, "arkade"))).toBe(
            "arkade:mutinynet/slip44:1",
        );
    });
});
